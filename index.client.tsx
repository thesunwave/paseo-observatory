import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ObservatorySurface } from "./client/observatory";

export default function contribute(client: PluginClientContext) {
  const cleanupSurface = client.addSurface("observatory", ObservatorySurface);
  const cleanupSidebar = client.addSidebarItem({
    id: "observatory",
    title: "Observatory",
    icon: "Activity",
    surface: "observatory",
  });

  return () => {
    cleanupSidebar();
    cleanupSurface();
  };
}
