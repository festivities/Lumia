
const path = require('path');
const originalUrl = 'https://pbs.twimg.com/media/HKlAs4aXcAAzPut.jpg:large';
let fileName = path.basename(new URL(originalUrl).pathname) || 'restored_media';
fileName = fileName.split(':')[0];
fileName = fileName.replace(/[^a-zA-Z0-9.\-_]/g, '_');
console.log(fileName);

