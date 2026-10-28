// Host-mounted configuration avoids embedding credentials in image metadata.
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('/run/secrets/runtime.json', 'utf8'));
for (const [name, value] of Object.entries(config)) {
  if (typeof value !== 'string') throw new Error('Runtime configuration must contain strings');
  process.env[name] = value;
}
// The tracker may include authenticated upstream URLs in diagnostics. Redact
// credential values before either output stream reaches the host log driver.
const secrets = Object.entries(config)
  .filter(([name, value]) => value.length >= 16)
  .map(([, value]) => value)
  .sort((a, b) => b.length - a.length);
if (require.main === module) {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, process.argv.slice(2), {
    env: process.env,
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  for (const [input, output] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    let pending = '';
    const write = (line) => {
      for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
      output.write(line);
    };
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        write(pending.slice(0, end + 1));
        pending = pending.slice(end + 1);
      }
      // Do not retain an unbounded malformed log line or emit an unredacted fragment.
      if (pending.length > 1024 * 1024) {
        pending = '';
        output.write('[oversized log line omitted]\n');
      }
    });
    input.on('end', () => { if (pending) write(pending); });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { process.stderr.write('Application launch failed\n'); process.exitCode = 1; });
  child.on('close', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
