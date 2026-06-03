const cp = require('child_process');
const p = cp.spawn('node', ['dist/surfaces/mcp/server.js']);
p.stdout.on('data', d => console.log('OUT:', d.toString()));
p.stderr.on('data', d => console.error('ERR:', d.toString()));
p.stdin.write(JSON.stringify({jsonrpc: "2.0", id: 1, method: "initialize", params: {protocolVersion: "2024-11-05", capabilities: {}, clientInfo: {name: "cursor", version: "1.0.0"}}}) + '\n');
setTimeout(() => p.kill(), 1000);
