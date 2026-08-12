const k = process.env.ODDS_API_KEY;
(async () => {
  const sports = await (await fetch("https://api.the-odds-api.com/v4/sports?apiKey=" + k)).json();
  const tennis = sports.filter(s => s.key.indexOf("tennis_") === 0);
  console.log("TENNIS KEYS:", tennis.map(s => s.key).join(", ") || "(none)");
  for (const s of tennis) {
    const r = await fetch("https://api.the-odds-api.com/v4/sports/" + s.key + "/odds?apiKey=" + k + "&regions=us&markets=h2h&oddsFormat=decimal");
    if (!r.ok) { console.log(s.key + " -> HTTP " + r.status); continue; }
    const ev = await r.json();
    const withBooks = ev.filter(e => (e.bookmakers || []).length).length;
    console.log("");
    console.log(s.key + ": " + ev.length + " events, " + withBooks + " with bookmakers");
    ev.slice(0, 5).forEach(e => {
      const books = (e.bookmakers || []).map(b => b.key);
      console.log("   " + e.home_team + " vs " + e.away_team + " -> " + books.length + " books" + (books.length ? " [" + books.slice(0,4).join(",") + "]" : ""));
    });
  }
})();
