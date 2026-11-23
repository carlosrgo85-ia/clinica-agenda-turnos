import { Outlet } from "react-router-dom";
import { Sidebar } from "./Sidebar";
import { MobileNav } from "./MobileNav";
import { BannerStack } from "./BannerStack";
import { CommandPalette } from "./CommandPalette";
import { PageContainer } from "./PageContainer";

/**
 * Único lugar que compone el "chrome" de la app (sidebar, nav móvil,
 * banners). Las páginas (`<Outlet/>`) renderizan solo su contenido — nunca
 * el nav ni el header.
 */
export function AppLayout() {
  return (
    <div className="app-shell">
      <Sidebar />
      <div className="app-main">
        <MobileNav />
        <BannerStack />
        <div className="app-content">
          <PageContainer>
            <Outlet />
          </PageContainer>
        </div>
      </div>
      <CommandPalette />
    </div>
  );
}
