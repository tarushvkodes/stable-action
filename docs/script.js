/* Scroll-driven fade-in for sections */
document.addEventListener("DOMContentLoaded", function () {
  var targets = document.querySelectorAll(".fade-in");

  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("visible");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.15 }
    );

    targets.forEach(function (el) {
      observer.observe(el);
    });
  } else {
    /* Fallback: show everything immediately */
    targets.forEach(function (el) {
      el.classList.add("visible");
    });
  }

  /* Shrink nav on scroll */
  var nav = document.querySelector(".nav");
  window.addEventListener("scroll", function () {
    if (window.scrollY > 40) {
      nav.style.boxShadow = "0 2px 20px rgba(0,0,0,0.4)";
    } else {
      nav.style.boxShadow = "none";
    }
  });
});
