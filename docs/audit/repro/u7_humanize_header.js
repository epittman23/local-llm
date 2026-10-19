const humanizeHeader = (col) => col.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
const data={derived_columns:[{config_id:'abc',gen_tps:7.5}],derived:[{config_id:'abc',ms_per_token:133}]};
try{ data.derived_columns.map(c=>humanizeHeader(c)); }catch(e){console.log('serving:',e.message)}
const b={columns:['humaneval'],rows:[{model:'m',per_benchmark:{humaneval:{pass_rate:0.5}},pass_rate:0.5}]};
console.log('benchmark cells:', b.rows.map(r=>b.columns.map(c=>r[c])));
