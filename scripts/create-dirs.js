// scripts/create-dirs.js
const fs = require('fs');
const path = require('path');

console.log('📁 Creating required directories...');

const dirs = [
    './templates',
    './services',
    './scripts',
    './logs',
    './data'
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`✅ Created: ${dir}`);
    } else {
        console.log(`✓ Exists: ${dir}`);
    }
});

console.log('✅ Directory setup complete!');