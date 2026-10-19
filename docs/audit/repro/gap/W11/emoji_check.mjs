import fs from 'fs';
const dir = process.argv[2];
const sc = JSON.parse(fs.readFileSync(dir+'/emoji-shortcodes.json','utf8'));
const gr = JSON.parse(fs.readFileSync(dir+'/emoji-groups.json','utf8'));
const scKeys = Object.keys(sc);
console.log('shortcode keys', scKeys.length, 'value types', [...new Set(Object.values(sc).map(v=>Array.isArray(v)?'array':typeof v))]);
console.log('non-upper keys', scKeys.filter(k=>k!==k.toUpperCase()).slice(0,5));
console.log('non-hex keys', scKeys.filter(k=>!/^[0-9A-F]+(-[0-9A-F]+)*$/.test(k)).slice(0,5));
const names = {};
for (const [k,v] of Object.entries(sc)) for (const n of (typeof v==='string'?[v]:v)) (names[n]??=[]).push(k);
const dup = Object.entries(names).filter(([n,ks])=>ks.length>1);
console.log('shortcodes mapped to >1 code', dup.length, dup.slice(0,10));
console.log('names with uppercase', Object.keys(names).filter(n=>n!==n.toLowerCase()).slice(0,10));
console.log('names with space', Object.keys(names).filter(n=>/\s/.test(n)).slice(0,10));
const groupCodes = Object.values(gr).flat();
console.log('group codes', groupCodes.length, 'unique', new Set(groupCodes).size);
const missing = groupCodes.filter(c=>!(c in sc));
console.log('group codes with no shortcode', missing.length, missing.slice(0,20));
const notInGroups = scKeys.filter(k=>!groupCodes.includes(k));
console.log('shortcode codes not in any group', notInGroups.length, notInGroups.slice(0,20));
// empty arrays
console.log('empty name lists', scKeys.filter(k=>Array.isArray(sc[k])&&sc[k].length===0));
// duplicates in picker: same first name across items
const firsts = {};
for (const c of groupCodes) if (sc[c]) { const n=(typeof sc[c]==='string'?[sc[c]]:sc[c])[0]; (firsts[n]??=[]).push(c);}
console.log('picker items sharing a submitted name', Object.entries(firsts).filter(([n,c])=>c.length>1).slice(0,10));
// codepoint validity
let bad=[]; for (const k of scKeys){ try{ String.fromCodePoint(...k.split('-').map(h=>parseInt(h,16))) }catch(e){bad.push(k)} }
console.log('invalid codepoints', bad);
