use super::{EngineError, EngineErrorCode};
use hound::{SampleFormat, WavReader};
use std::f64::consts::PI;
use std::path::Path;

const TRANSCRIPTION_SAMPLE_RATE: u32 = 16_000;
const SINC_RADIUS: i64 = 24;

fn invalid_audio(message: &'static str) -> EngineError {
    EngineError::new(EngineErrorCode::AudioInvalid, message, true)
}

fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32), EngineError> {
    let mut reader = WavReader::open(path)
        .map_err(|_| invalid_audio("Audio must be a readable PCM WAV file."))?;
    let specification = reader.spec();
    if specification.channels == 0 || specification.sample_rate == 0 {
        return Err(invalid_audio(
            "Audio has an invalid channel count or sample rate.",
        ));
    }

    let interleaved = match (specification.sample_format, specification.bits_per_sample) {
        (SampleFormat::Float, 32) => reader
            .samples::<f32>()
            .map(|sample| sample.map_err(|_| invalid_audio("Audio samples could not be decoded.")))
            .collect::<Result<Vec<_>, _>>()?,
        (SampleFormat::Int, 1..=8) => reader
            .samples::<i8>()
            .map(|sample| {
                sample
                    .map(|value| value as f32 / 128.0)
                    .map_err(|_| invalid_audio("Audio samples could not be decoded."))
            })
            .collect::<Result<Vec<_>, _>>()?,
        (SampleFormat::Int, 9..=16) => reader
            .samples::<i16>()
            .map(|sample| {
                sample
                    .map(|value| value as f32 / 32_768.0)
                    .map_err(|_| invalid_audio("Audio samples could not be decoded."))
            })
            .collect::<Result<Vec<_>, _>>()?,
        (SampleFormat::Int, 17..=32) => {
            let scale = 2_f32.powi(i32::from(specification.bits_per_sample) - 1);
            reader
                .samples::<i32>()
                .map(|sample| {
                    sample
                        .map(|value| value as f32 / scale)
                        .map_err(|_| invalid_audio("Audio samples could not be decoded."))
                })
                .collect::<Result<Vec<_>, _>>()?
        }
        _ => {
            return Err(invalid_audio(
                "Audio uses an unsupported WAV sample format.",
            ));
        }
    };

    if interleaved.is_empty() || interleaved.iter().any(|sample| !sample.is_finite()) {
        return Err(invalid_audio("Audio does not contain valid samples."));
    }
    let channel_count = usize::from(specification.channels);
    if interleaved.len() % channel_count != 0 {
        return Err(invalid_audio("Audio contains an incomplete channel frame."));
    }
    let mono = interleaved
        .chunks_exact(channel_count)
        .map(|frame| frame.iter().copied().sum::<f32>() / channel_count as f32)
        .collect();
    Ok((mono, specification.sample_rate))
}

fn resample_to_transcription_rate(samples: &[f32], source_sample_rate: u32) -> Vec<f32> {
    if source_sample_rate == TRANSCRIPTION_SAMPLE_RATE {
        return samples.to_vec();
    }
    let output_length = ((samples.len() as u64 * u64::from(TRANSCRIPTION_SAMPLE_RATE)
        + u64::from(source_sample_rate) / 2)
        / u64::from(source_sample_rate)) as usize;
    let source_frames_per_output = source_sample_rate as f64 / TRANSCRIPTION_SAMPLE_RATE as f64;
    let cutoff = (TRANSCRIPTION_SAMPLE_RATE as f64 / source_sample_rate as f64).min(1.0) * 0.94;
    let mut output = Vec::with_capacity(output_length);

    for output_index in 0..output_length {
        let source_position = output_index as f64 * source_frames_per_output;
        let centre = source_position.floor() as i64;
        let mut weighted_sample = 0.0_f64;
        let mut weight_sum = 0.0_f64;
        for source_index in (centre - SINC_RADIUS + 1)..=(centre + SINC_RADIUS) {
            if source_index < 0 || source_index >= samples.len() as i64 {
                continue;
            }
            let distance = source_position - source_index as f64;
            let absolute_distance = distance.abs();
            if absolute_distance > SINC_RADIUS as f64 {
                continue;
            }
            let low_pass = if absolute_distance < f64::EPSILON {
                cutoff
            } else {
                (PI * cutoff * distance).sin() / (PI * distance)
            };
            let window = 0.5 + 0.5 * (PI * distance / SINC_RADIUS as f64).cos();
            let weight = low_pass * window;
            weighted_sample += samples[source_index as usize] as f64 * weight;
            weight_sum += weight;
        }
        output.push(if weight_sum.abs() > f64::EPSILON {
            (weighted_sample / weight_sum).clamp(-1.0, 1.0) as f32
        } else {
            0.0
        });
    }
    output
}

pub(crate) fn read_normalised_wav(path: &Path) -> Result<Vec<f32>, EngineError> {
    let (samples, sample_rate) = decode_wav(path)?;
    let normalised = resample_to_transcription_rate(&samples, sample_rate);
    if normalised.is_empty() {
        return Err(invalid_audio("Audio is too short to transcribe."));
    }
    Ok(normalised)
}

#[cfg(test)]
mod tests {
    use super::*;
    use hound::{WavSpec, WavWriter};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn normalises_48_khz_audio_to_the_engine_sample_rate() {
        let input = vec![0.25; 48_000];
        let output = resample_to_transcription_rate(&input, 48_000);

        assert_eq!(output.len(), TRANSCRIPTION_SAMPLE_RATE as usize);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!(
            output
                .iter()
                .skip(24)
                .all(|sample| (*sample - 0.25).abs() < 0.001)
        );
    }

    #[test]
    fn preserves_audio_already_at_the_engine_sample_rate() {
        let input = vec![-0.5, 0.0, 0.5];
        assert_eq!(
            resample_to_transcription_rate(&input, TRANSCRIPTION_SAMPLE_RATE),
            input
        );
    }

    #[test]
    fn reads_and_normalises_a_windows_style_48_khz_wav() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("crunchymurmur-48k-{unique}.wav"));
        let mut writer = WavWriter::create(
            &path,
            WavSpec {
                channels: 1,
                sample_rate: 48_000,
                bits_per_sample: 16,
                sample_format: SampleFormat::Int,
            },
        )
        .unwrap();
        for _ in 0..48_000 {
            writer.write_sample(8_192_i16).unwrap();
        }
        writer.finalize().unwrap();

        let output = read_normalised_wav(&path).unwrap();
        assert_eq!(output.len(), 16_000);
        assert!(
            output
                .iter()
                .skip(24)
                .all(|sample| (*sample - 0.25).abs() < 0.001)
        );
        fs::remove_file(path).unwrap();
    }
}
