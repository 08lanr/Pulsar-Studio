const SW=new Set(["the","and","but","for","with","from","that","this","then","than","now","not","his","her","him","she","they","them","their","its","our","your","you","who","was","were","are","has","have","had","will","would","could","did","does","all","any","one","out","off","own","too","very","just","only","into","onto","over","after","before","when","what","why","how","another","about"]);
const stem=w=>w.replace(/(ings|ing|ed|es|s)$/,"");
const words=t=>t.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/).filter(w=>w.length>2&&!SW.has(w)).map(stem).filter(w=>w.length>2);
const cases=[
 ["I lied about New York. I trained in California all summer, then returned to Ridgewater.","Dumped for the Cheer Queen, I Came Back and Took Her Crown","KEEP"],
 ["He humiliated her to make another girl laugh. A month later he begged her back. She said no.","He Humiliated Me in Front of the Whole School, Now He's Begging For Me Back","DROP"],
 ["He humiliated her for a laugh. Now he wants her back, and she's done.","He Humiliated Me in Front of the Whole School, Now He's Begging For Me Back","DROP"],
 ["The guy I loved told me to flirt with his rival. So I did.","He Told Me to Flirt With His Rival. Then I Fell For Him","DROP"],
 ["My secret boyfriend told the whole party I wasn't his type.","Dumped for the Cheer Queen, I Came Back and Took Her Crown","KEEP"],
];
for(const [hook,title,want] of cases){
  const tw=[...new Set(words(title))], hw=new Set(words(hook));
  const shared=tw.filter(w=>hw.has(w));
  const ratio=shared.length/tw.length;
  const sameOpening=words(hook)[0]===words(title)[0];
  console.log(`${want.padEnd(5)} ratio=${ratio.toFixed(2)} sameOpening=${String(sameOpening).padEnd(5)} shared=[${shared}]  hookFirst=${words(hook)[0]} titleFirst=${words(title)[0]}`);
}
