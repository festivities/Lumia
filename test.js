
(async () => {
  const links = await import('./src/links.js');
  console.log('Fetching...');
  const res = await links.fetchGuarded('https://pbs.twimg.com/media/HKlAs4aXcAAzPut.jpg:large', 50 * 1024 * 1024);
  console.log('Result:', res ? res.contentType : 'null');
})();

