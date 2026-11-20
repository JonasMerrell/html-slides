// Runs in a sandboxed iframe while its slide is showing (present mode and exported decks).
// `Embed` comes from the deck: see "Interactive embeds" in AGENTS.md.
Embed.start(async () => {
  const data = await Embed.data('data.json'); // any file in this folder; still works offline after export
  const chart = document.getElementById('chart');
  // colours come from the deck theme as CSS variables (var(--s1) in index.html);
  // for canvas/WebGL code read them with Embed.css('--s1', '#2A78D6')
  const draw = () => { chart.innerHTML = data.values.map((v) => `<div style="height:${v}%"></div>`).join(''); };
  document.getElementById('more').onclick = () => {
    data.values.push(Math.round(20 + Math.random() * 80));
    if (data.values.length > 10) data.values.shift();
    draw();
  };
  draw();
  Embed.ready(); // first frame is drawn: the deck now swaps the poster for this page
});
