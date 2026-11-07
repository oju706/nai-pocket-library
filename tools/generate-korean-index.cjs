// Read only JSON data. Images are never executed or copied into the app.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
async function main() {
  const [source, output] = process.argv.slice(2);
  if (!source || !output) throw new Error('Usage: node generate-korean-index.cjs SOURCE OUTPUT');
  const artists = [], names = new Set(), hash = crypto.createHash('sha256');
  let base = 0, phase = 'object', inString = false, start = 0, key = '', keyParts = [], images = [], trailing = 0;
  for await (const chunk of fs.createReadStream(source, {highWaterMark: 4 * 1024 * 1024})) {
    hash.update(chunk);
    let pos = 0;
    while (pos < chunk.length) {
      if (inString) {
        const from = pos;
        let end = chunk.indexOf(34, pos);
        while (end >= 0) {
          let back = end - 1;
          while (back >= from && chunk[back] === 92) back--;
          const escapes = end - back - 1 + (back < from ? trailing : 0);
          if (escapes % 2 === 0) break;
          end = chunk.indexOf(34, end + 1);
        }
        const stop = end < 0 ? chunk.length : end;
        if (phase === 'key') {
          keyParts.push(chunk.subarray(from, stop));
          if (base + stop - start > 1600) throw new Error('Artist key too long');
        }
        if (end < 0) {
          let back = chunk.length - 1;
          while (back >= from && chunk[back] === 92) back--;
          trailing = chunk.length - back - 1 + (back < from ? trailing : 0);
          pos = chunk.length;
          continue;
        }
        inString = false; trailing = 0; pos = end + 1;
        if (phase === 'key') {
          key = JSON.parse('"' + Buffer.concat(keyParts).toString('utf8') + '"');
          keyParts = []; phase = 'colon';
        } else {
          const size = base + end - start;
          if (size > 6 * 1024 * 1024) throw new Error('Image exceeds app limit');
          images.push([start, size]); phase = 'afterImage';
        }
        continue;
      }
      const ch = chunk[pos];
      if ([9,10,13,32].includes(ch)) { pos++; continue; }
      if (phase === 'object' && ch === 123) phase = 'key';
      else if (phase === 'key' && ch === 34) { inString = true; start = base + pos + 1; }
      else if (phase === 'colon' && ch === 58) phase = 'array';
      else if (phase === 'array' && ch === 91) { images = []; phase = 'image'; }
      else if (phase === 'image' && ch === 34) { inString = true; start = base + pos + 1; }
      else if ((phase === 'afterImage' || phase === 'image') && ch === 93) {
        if (names.has(key)) throw new Error('Duplicate artist key');
        names.add(key); artists.push([key, images]); phase = 'afterArtist';
      } else if (phase === 'afterImage' && ch === 44) phase = 'image';
      else if (phase === 'afterArtist' && ch === 44) phase = 'key';
      else if (phase === 'afterArtist' && ch === 125) phase = 'done';
      else throw new Error(`Unexpected byte ${ch} in ${phase} at ${base + pos}`);
      pos++;
    }
    base += chunk.length;
  }
  const sha256 = hash.digest('hex');
  if (inString || phase !== 'done') throw new Error('Incomplete JSON');
  if (sha256 !== '724ee2b0c906159c22ba28566f0d0aa2aee350e81896294ac0ded22c23144fac') throw new Error('Source does not match original author SHA-256');
  const result = {format:'nai-pocket-korean-index',version:1,source:{
    url:'https://huggingface.co/baqu2213/PoemForSmallFThings/resolve/main/NAIA/NAID5_artist_thumbnail/NAID5-33000-55000-Curated',
    bytes:base,etag:'"9d58a81b3c6310e6370d7b96374241a678bf445e634b6beb1806ff8b99e14a93"',
    sha256,author:'bequiet / baqu2213',model:'V5',post:'https://arca.live/b/aiart/185691299'},artists};
  fs.mkdirSync(path.dirname(output), {recursive:true});
  fs.writeFileSync(output, JSON.stringify(result));
  console.log(JSON.stringify({artists:artists.length,images:artists.reduce((n,x)=>n+x[1].length,0),indexBytes:fs.statSync(output).size,sha256}));
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
