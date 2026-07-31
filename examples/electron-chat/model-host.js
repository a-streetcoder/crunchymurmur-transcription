const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');

const MODEL_ID = 'parakeet-v3';
const DIRECTORY_NAME = 'parakeet-tdt-0.6b-v3-int8';
const MODEL_FILES = [
  { path: 'encoder-model.int8.onnx', bytes: 652_183_999, sha256: '6139d2fa7e1b086097b277c7149725edbab89cc7c7ae64b23c741be4055aff09' },
  { path: 'decoder_joint-model.int8.onnx', bytes: 18_202_004, sha256: 'eea7483ee3d1a30375daedc8ed83e3960c91b098812127a0d99d1c8977667a70' },
  { path: 'nemo128.onnx', bytes: 139_764, sha256: 'a9fde1486ebfcc08f328d75ad4610c67835fea58c73ba57e3209a6f6cf019e9f' },
  { path: 'vocab.txt', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
  { path: 'config.json', bytes: 97, sha256: '666903c76b9798caf2c210afd4f6cd60b08a8dbf9800ec8d7a3bc0d2148ac466' },
];
const TOTAL_BYTES = MODEL_FILES.reduce((total, file) => total + file.bytes, 0);
const LANGUAGES = [
  'auto', 'bg', 'hr', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el',
  'hu', 'it', 'lv', 'lt', 'mt', 'pl', 'pt', 'ro', 'sk', 'sl', 'es', 'sv',
  'ru', 'uk',
];
const SOURCE_ROOT = 'https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx/resolve/main';
const WHISPER_NAMES = {
  'tiny.en': 'Whisper Tiny English',
  base: 'Whisper Base',
  small: 'Whisper Small',
  medium: 'Whisper Medium',
  'large-v3-turbo-q5_0': 'Whisper Large V3 Turbo (Q5)',
  'large-v3-turbo': 'Whisper Large V3 Turbo',
  'large-v3': 'Whisper Large V3',
};

function expectedManifest() {
  return {
    schemaVersion: 1,
    modelId: MODEL_ID,
    modelVersion: '1.0.0',
    engine: 'parakeet',
    quantisation: 'int8',
    languages: [...LANGUAGES],
    files: MODEL_FILES.map((file) => ({ ...file })),
    minimumEngineVersion: '0.1.0',
  };
}

function manifestMatchesKnownRelease(candidate) {
  if (!candidate || typeof candidate !== 'object') return false;
  return JSON.stringify(candidate) === JSON.stringify(expectedManifest());
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hasKnownFiles(directory, fileSystem = fs) {
  return MODEL_FILES.every((file) => {
    try {
      const stat = fileSystem.statSync(path.join(directory, file.path));
      return stat.isFile() && stat.size === file.bytes;
    } catch {
      return false;
    }
  });
}

function writeManifest(directory, fileSystem = fs) {
  const manifestPath = path.join(directory, 'crunchymurmur-model.json');
  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  const contents = `${JSON.stringify(expectedManifest(), null, 2)}\n`;
  fileSystem.writeFileSync(temporaryPath, contents, { encoding: 'utf8', mode: 0o600 });
  fileSystem.renameSync(temporaryPath, manifestPath);
  return contents;
}

function inspectKnownProfile(directory, fileSystem = fs) {
  if (!hasKnownFiles(directory, fileSystem)) return null;
  const manifestPath = path.join(directory, 'crunchymurmur-model.json');
  let contents;
  try {
    contents = fileSystem.readFileSync(manifestPath, 'utf8');
    if (!manifestMatchesKnownRelease(JSON.parse(contents))) return null;
  } catch {
    try {
      contents = writeManifest(directory, fileSystem);
    } catch {
      return null;
    }
  }
  return {
    id: MODEL_ID,
    engine: 'parakeet',
    name: 'Parakeet V3',
    description: 'Fast · 25 European languages · 640 MB',
    directory,
    trustedManifestSha256: sha256(contents),
    languages: [...LANGUAGES],
    bytes: TOTAL_BYTES,
  };
}

function uniqueExistingDirectories(roots, fileSystem = fs) {
  const directories = [];
  const seen = new Set();
  for (const root of roots) {
    if (!root) continue;
    const candidate = path.join(root, DIRECTORY_NAME);
    try {
      const canonical = fileSystem.realpathSync(candidate);
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      directories.push(canonical);
    } catch {}
  }
  return directories;
}

function downloadFile(url, destination, expected, {
  fileSystem = fs,
  httpsModule = https,
  onChunk,
} = {}) {
  return new Promise((resolve, reject) => {
    const digest = crypto.createHash('sha256');
    const output = fileSystem.createWriteStream(destination, { mode: 0o600 });
    let received = 0;
    let settled = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) {
        try { output.destroy(); } catch {}
        reject(error);
      } else {
        resolve();
      }
    };

    const request = (nextUrl, redirects = 0) => {
      const req = httpsModule.get(nextUrl, { headers: { 'User-Agent': 'CrunchyMurmur-SDK-Demo' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          response.resume();
          if (redirects >= 5) return finish(new Error('Too many model download redirects.'));
          const redirect = new URL(response.headers.location, nextUrl);
          if (redirect.protocol !== 'https:') return finish(new Error('Model download redirected to an insecure URL.'));
          request(redirect, redirects + 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          finish(new Error(`Model download failed with HTTP ${response.statusCode}.`));
          return;
        }
        response.on('data', (chunk) => {
          received += chunk.length;
          digest.update(chunk);
          onChunk?.(chunk.length);
        });
        response.on('error', finish);
        response.pipe(output);
      });
      req.on('error', finish);
      req.setTimeout?.(60_000, () => req.destroy(new Error('Model download timed out.')));
    };

    output.on('finish', () => {
      if (received !== expected.bytes) {
        finish(new Error(`Incomplete model file: ${expected.path}`));
        return;
      }
      if (digest.digest('hex') !== expected.sha256) {
        finish(new Error(`Checksum mismatch for model file: ${expected.path}`));
        return;
      }
      finish();
    });
    output.on('error', finish);
    request(url);
  });
}

function createModelHost({
  roots,
  installRoot,
  fileSystem = fs,
  httpsModule = https,
} = {}) {
  const searchRoots = [...new Set([installRoot, ...(roots || [])].filter(Boolean))];
  let installation = null;

  function whisperProfiles() {
    const profiles = [];
    const seen = new Set();
    for (const root of searchRoots) {
      let entries;
      try {
        entries = fileSystem.readdirSync(root, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.startsWith('ggml-') || !entry.name.endsWith('.bin')) {
          continue;
        }
        const modelName = entry.name.slice('ggml-'.length, -'.bin'.length);
        if (!/^[a-zA-Z0-9._-]+$/.test(modelName)) continue;
        const id = `whisper:${modelName}`;
        if (seen.has(id)) continue;
        const modelPath = path.join(root, entry.name);
        let bytes;
        try {
          bytes = fileSystem.statSync(modelPath).size;
        } catch {
          continue;
        }
        if (bytes < 1024 * 1024) continue;
        seen.add(id);
        profiles.push({
          id,
          engine: 'whisper',
          name: WHISPER_NAMES[modelName] || `Whisper ${modelName}`,
          description: `Local · multilingual · ${Math.round(bytes / 1024 / 1024)} MB`,
          modelPath,
          bytes,
        });
      }
    }
    return profiles;
  }

  function list() {
    const seenModelIds = new Set();
    const parakeet = uniqueExistingDirectories(searchRoots, fileSystem)
      .map((directory) => inspectKnownProfile(directory, fileSystem))
      .filter(Boolean)
      .filter((profile) => {
        if (seenModelIds.has(profile.id)) return false;
        seenModelIds.add(profile.id);
        return true;
      })
      .map(({ directory, trustedManifestSha256, ...publicProfile }) => publicProfile);
    const whisper = whisperProfiles()
      .map(({ modelPath, ...publicProfile }) => publicProfile);
    return [...parakeet, ...whisper];
  }

  function resolve(modelId) {
    if (modelId === MODEL_ID) {
      for (const directory of uniqueExistingDirectories(searchRoots, fileSystem)) {
        const profile = inspectKnownProfile(directory, fileSystem);
        if (profile) return profile;
      }
      return null;
    }
    if (!String(modelId || '').startsWith('whisper:')) return null;
    return whisperProfiles().find((profile) => profile.id === modelId) || null;
  }

  async function installRecommended(onProgress) {
    const existing = resolve(MODEL_ID);
    if (existing) return existing;
    if (installation) return installation;
    installation = (async () => {
      fileSystem.mkdirSync(installRoot, { recursive: true });
      const finalDirectory = path.join(installRoot, DIRECTORY_NAME);
      const stagingDirectory = path.join(installRoot, `.${DIRECTORY_NAME}.partial`);
      fileSystem.rmSync(stagingDirectory, { recursive: true, force: true });
      fileSystem.mkdirSync(stagingDirectory, { recursive: true });
      let completed = 0;
      try {
        for (const file of MODEL_FILES) {
          await downloadFile(
            `${SOURCE_ROOT}/${encodeURIComponent(file.path)}`,
            path.join(stagingDirectory, file.path),
            file,
            {
              fileSystem,
              httpsModule,
              onChunk(bytes) {
                completed += bytes;
                onProgress?.({ bytesDone: completed, bytesTotal: TOTAL_BYTES });
              },
            },
          );
        }
        writeManifest(stagingDirectory, fileSystem);
        fileSystem.rmSync(finalDirectory, { recursive: true, force: true });
        fileSystem.renameSync(stagingDirectory, finalDirectory);
        const profile = inspectKnownProfile(finalDirectory, fileSystem);
        if (!profile) throw new Error('The downloaded model could not be verified.');
        return profile;
      } finally {
        fileSystem.rmSync(stagingDirectory, { recursive: true, force: true });
      }
    })();
    try {
      return await installation;
    } finally {
      installation = null;
    }
  }

  return { installRecommended, list, resolve };
}

module.exports = {
  DIRECTORY_NAME,
  LANGUAGES,
  MODEL_FILES,
  MODEL_ID,
  TOTAL_BYTES,
  createModelHost,
  expectedManifest,
  inspectKnownProfile,
  manifestMatchesKnownRelease,
};
