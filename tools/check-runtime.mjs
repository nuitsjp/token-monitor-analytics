const [major,minor]=process.versions.node.split('.').map(Number);
if(major<22||(major===22&&minor<16))throw new Error('Node.js 22.16+ required; use Node.js 24 LTS latest patch in production.');
await import('node:sqlite');
await import('../analytics/src/estimate.ts');
console.log(`Node.js ${process.versions.node}: SQLite and native TypeScript loading OK.`);
