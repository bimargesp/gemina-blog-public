/* Gémina Blog — main.js (reveal + filtro de categorías) */

document.documentElement.classList.add("js");

// ── Reveal on scroll ─────────────────────────────────────────────
const revealEls = document.querySelectorAll(".reveal");
if (revealEls.length > 0 && "IntersectionObserver" in window) {
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry, i) => {
        if (entry.isIntersecting) {
          setTimeout(() => entry.target.classList.add("visible"), i * 60);
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.08, rootMargin: "0px 0px -40px 0px" }
  );
  revealEls.forEach((el) => observer.observe(el));
} else {
  revealEls.forEach((el) => el.classList.add("visible"));
}

// ── Filtro de categorías ──────────────────────────────────────────
const filterBtns = document.querySelectorAll(".filter-btn");
const postsGrid = document.getElementById("postsGrid");

if (filterBtns.length > 0 && postsGrid) {
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const filter = btn.dataset.filter;
      postsGrid.querySelectorAll(".post-card").forEach((card) => {
        const show = filter === "all" || card.dataset.category === filter;
        card.hidden = !show;
        if (show) card.classList.add("visible");
      });
    });
  });
}
