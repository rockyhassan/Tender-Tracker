import { StrictMode } from "react"; import { createRoot } from "react-dom/client"; import "./styles.css"; import App from "./App";

if (typeof window !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, { once: true });
}

createRoot(document.getElementById("root")!).render(<StrictMode><App/></StrictMode>);
