async function test() {
  await new Promise(r => setTimeout(r, 5000)); // wait for server
  const res = await fetch('http://localhost:9090/api/home');
  const d = await res.json();
  console.log('Total sections:', d.data.total);
  d.data.sections.forEach((s,i) => {
    const thumb = s.contents[0]?.thumbnails?.[0]?.url || 'NO IMAGE';
    console.log(`${i+1}. ${s.title} [${s.contents.length} items] | img: ...${thumb.slice(-30)}`);
  });
}
test().catch(console.error);
