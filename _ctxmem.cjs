// Per-run context + memory profile from the live gateway DB.
// Usage: node _ctxmem.cjs <correlationId>
const path = require('path');
const os = require('os');
const fs = require('fs');
const Database = require('/app/node_modules/better-sqlite3');

const WINDOW = 32000; // local Gemma context window, for % calc

const dbPath = '/home/node/.missioncontrol/gateway.sqlite';
if (!fs.existsSync(dbPath)) { console.log('DB not found at ' + dbPath); process.exit(1); }
const db = new Database(dbPath, { readonly: true });

let cid = process.argv[2];
if (!cid) {
  const r = db.prepare('SELECT correlation_id FROM model_call_log ORDER BY created_at DESC LIMIT 1').get();
  cid = r ? r.correlation_id : '(none)';
  console.log('(no cid given — profiling most recent run: ' + cid + ')\n');
}

console.log('=== CONTEXT — model calls for cid=' + cid + ' ===');
const calls = db.prepare(
  'SELECT agent_id, input_tokens, output_tokens, duration_ms FROM model_call_log WHERE correlation_id = ? ORDER BY created_at ASC'
).all(cid);
if (calls.length === 0) {
  console.log('(no model calls found for this cid)');
} else {
  let peak = 0, sumIn = 0, sumOut = 0;
  for (const c of calls) {
    peak = Math.max(peak, c.input_tokens);
    sumIn += c.input_tokens; sumOut += c.output_tokens;
    const tps = c.duration_ms > 0 ? (c.output_tokens * 1000 / c.duration_ms).toFixed(1) : 'n/a';
    const pct = (c.input_tokens / WINDOW * 100).toFixed(0);
    console.log(
      String(c.agent_id).padEnd(26) +
      ' ctx=' + String(c.input_tokens).padStart(6) + ' (' + pct + '%)' +
      '  out=' + String(c.output_tokens).padStart(5) +
      '  ' + (c.duration_ms / 1000).toFixed(1) + 's  ' + tps + ' t/s'
    );
  }
  console.log('-- ' + calls.length + ' calls | peak ctx ' + peak +
    ' (' + (peak / WINDOW * 100).toFixed(0) + '% of ' + WINDOW + ') | total in ' + sumIn + ' out ' + sumOut);
}

console.log('\n=== TOOLS for cid=' + cid + ' ===');
const tools = db.prepare(
  'SELECT tool_name, status, COUNT(*) n FROM tool_call_log WHERE correlation_id = ? GROUP BY tool_name, status ORDER BY tool_name'
).all(cid);
if (tools.length === 0) console.log('(no tool calls)');
for (const t of tools) console.log(String(t.tool_name).padEnd(18) + ' ' + t.status + '  x' + t.n);

console.log('\n=== MEMORY subsystem (current state) ===');
const mc = db.prepare(
  'SELECT COUNT(*) n, COALESCE(SUM(LENGTH(content)),0) sz FROM memory_entries WHERE valid_until IS NULL'
).get();
console.log('current entries: ' + mc.n + ' | total size: ' + mc.sz + ' chars');
const recent = db.prepare(
  'SELECT agent_id, key, LENGTH(content) len, valid_from FROM memory_entries ORDER BY valid_from DESC LIMIT 5'
).all();
console.log('most recent entries:');
for (const e of recent) {
  console.log('  ' + new Date(e.valid_from).toISOString().slice(0, 19) + '  ' +
    String(e.agent_id).padEnd(24) + ' ' + String(e.key).slice(0, 30) + '  (' + e.len + ' chars)');
}
