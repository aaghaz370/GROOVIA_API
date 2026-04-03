const { Innertube } = require('youtubei.js');

async function test() {
  const yt = await Innertube.create({ generate_session_locally: true });
  let feed = await yt.music.getHomeFeed();
  
  for (let i = 0; i < 2; i++) {
    if (feed.has_continuation) {
      feed = await feed.getContinuation();
    } else break;
  }
  
  feed.sections?.forEach(s => {
    const item = s.contents?.[0];
    const thumbs = item?.thumbnails;
    let thumbInfo = 'none';
    if (Array.isArray(thumbs) && thumbs.length > 0) {
      thumbInfo = `array[${thumbs.length}] url="${thumbs[thumbs.length-1]?.url?.substring(0,60)}"`;
    } else if (thumbs) {
      thumbInfo = `obj: ${JSON.stringify(thumbs).substring(0, 80)}`;
    }
    console.log(`Section: ${s.header?.title?.text} | Type: ${item?.type} | Thumbs: ${thumbInfo}`);
  });
}

test().catch(console.error);
