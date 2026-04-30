import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import SidePanel from "./SidePanel";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <SidePanel />
    </StrictMode>
  );
}
