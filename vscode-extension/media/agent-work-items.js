(function () {
  document.querySelectorAll(".copy-btn").forEach((button) => {
    button.addEventListener("click", async () => {
      const targetId = button.getAttribute("data-copy-target");
      if (!targetId) {
        return;
      }
      const block = document.getElementById(targetId);
      if (!block) {
        return;
      }
      const text = block.textContent || "";
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = "Copied";
        button.classList.add("copied");
        setTimeout(() => {
          button.textContent = "Copy prompt";
          button.classList.remove("copied");
        }, 1500);
      } catch {
        button.textContent = "Copy failed";
      }
    });
  });
})();
