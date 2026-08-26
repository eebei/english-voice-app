import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';

const root = path.dirname(new URL(import.meta.url).pathname);
const linesPath = path.join(root, 'sample-lines.tsv');
const audioDir = path.join(root, 'audio');
const apiUrl = 'https://english-voice-app-production.up.railway.app/api/tts';

const rows = (await readFile(linesPath, 'utf8'))
  .trim()
  .split(/\r?\n/)
  .map((line) => {
    const tab = line.indexOf('\t');
    if (tab < 1) throw new Error(`Invalid sample line: ${line}`);
    return { name: line.slice(0, tab), text: line.slice(tab + 1) };
  });

await mkdir(audioDir, { recursive: true });

const expectedFiles = new Set(rows.map((row) => `${row.name}.mp3`));
for (const file of await readdir(audioDir)) {
  if (file.endsWith('.mp3') && !expectedFiles.has(file)) {
    await unlink(path.join(audioDir, file));
  }
}

for (const row of rows) {
  const response = await fetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: row.text,
      voice: 'en-GB-Neural2-B',
      languageCode: 'en-GB',
      rate: 1.18,
      pitch: -2.0,
    }),
  });
  if (!response.ok) {
    throw new Error(`${row.name}: TTS failed (${response.status}) ${await response.text()}`);
  }
  const payload = await response.json();
  if (!payload.audioContent) throw new Error(`${row.name}: audioContent missing`);
  await writeFile(path.join(audioDir, `${row.name}.mp3`), Buffer.from(payload.audioContent, 'base64'));
  process.stdout.write(`generated ${row.name}\n`);
}
