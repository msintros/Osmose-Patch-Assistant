// Inlines src/ into one self-contained HTML file: dist/osmose-patcher.html
const fs = require('fs'), path = require('path');
const r = f => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const html = r('index.html')
  .replace('/*STYLE*/', () => r('style.css'))
  .replace('/*PROTOCOL*/', () => r('protocol.js'))
  .replace('/*MODS*/', () => r('mods.js'))
  .replace('/*MODULES*/', () => r('modules.js'))
  .replace('/*APP*/', () => r('app.js'));
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'dist', 'osmose-patcher.html'), html);
console.log('wrote dist/osmose-patcher.html', html.length, 'bytes');
