async function loadArticles() {
  const res = await fetch('/api/articles');
  const data = await res.json();
  const grid = document.getElementById('articles');
  if (!data.length) {
    grid.innerHTML = '<p class="muted">Articles loading… check back in a minute.</p>';
    return;
  }
  grid.innerHTML = data.map(a => `
    <div class="article" onclick="window.open('${a.sourceLink}','_blank')">
      <span class="tag">${a.region}</span>
      <h3>${a.headline}</h3>
      <p>${a.subheading || ''}</p>
      <p style="margin-top:.8rem;font-size:.8rem">Source: ${a.source}</p>
    </div>`).join('');
}
async function checkout(plan) {
  const email = prompt('Enter your email to subscribe:');
  if (!email) return;
  const r = await fetch('/api/checkout', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ plan, email })
  });
  const data = await r.json();
  if (data.url) window.location = data.url;
  else alert(data.error || 'Setup payment keys first.');
}
loadArticles();
setInterval(loadArticles, 60000);