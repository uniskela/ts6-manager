import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Server, Hash, Users, Shield, ShieldCheck,
  Lock, Ban, KeyRound, FolderOpen, MessageSquareWarning, Mail,
  ScrollText, Settings, Bot, Cpu, ChevronDown, ChevronLeft, ChevronRight, Music, ListMusic, Tv, Github, BookOpen, Menu,
  ClipboardList,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore, type SidebarSectionId } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { BrandMark } from '@/components/shared/BrandMark';
import { APP_DOCUMENTATION_URL, APP_REPOSITORY_URL, APP_VERSION, APP_VERSION_LABEL } from '@/lib/app-version';

interface NavSection {
  id: SidebarSectionId;
  label: string;
  adminOnly?: boolean;
  items: Array<{
    to: string;
    icon: LucideIcon;
    label: string;
    adminOnly?: boolean;
  }>;
}

const navSections: NavSection[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/servers', icon: Server, label: 'Virtual Servers', adminOnly: true },
    ],
  },
  {
    id: 'management',
    label: 'Management',
    items: [
      { to: '/channels', icon: Hash, label: 'Channels' },
      { to: '/clients', icon: Users, label: 'Clients' },
      { to: '/server-groups', icon: Shield, label: 'Server Groups', adminOnly: true },
      { to: '/channel-groups', icon: ShieldCheck, label: 'Channel Groups', adminOnly: true },
      { to: '/permissions', icon: Lock, label: 'Permissions', adminOnly: true },
    ],
  },
  {
    id: 'security',
    label: 'Security',
    adminOnly: true,
    items: [
      { to: '/bans', icon: Ban, label: 'Bans', adminOnly: true },
      { to: '/tokens', icon: KeyRound, label: 'Tokens', adminOnly: true },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    adminOnly: true,
    items: [
      { to: '/files', icon: FolderOpen, label: 'Files', adminOnly: true },
      { to: '/complaints', icon: MessageSquareWarning, label: 'Complaints', adminOnly: true },
      { to: '/messages', icon: Mail, label: 'Messages', adminOnly: true },
    ],
  },
  {
    id: 'system',
    label: 'System',
    adminOnly: true,
    items: [
      { to: '/logs', icon: ScrollText, label: 'Server Logs', adminOnly: true },
      { to: '/audit', icon: ClipboardList, label: 'Admin Audit', adminOnly: true },
      { to: '/instance', icon: Cpu, label: 'Instance', adminOnly: true },
      { to: '/music-requests', icon: ListMusic, label: 'Music Request History', adminOnly: true },
    ],
  },
  {
    id: 'automation',
    label: 'Automation',
    adminOnly: true,
    items: [
      { to: '/bots', icon: Bot, label: 'Bot Flows', adminOnly: true },
      { to: '/music-bots', icon: Music, label: 'Music Bots', adminOnly: true },
      { to: '/iptv', icon: Tv, label: 'IPTV', adminOnly: true },
    ],
  },
];

interface NavigationContentProps {
  collapsed?: boolean;
  mobile?: boolean;
  onNavigate?: () => void;
}

function NavigationContent({ collapsed = false, mobile = false, onNavigate }: NavigationContentProps) {
  const isAdmin = useAuthStore((s) => s.isAdmin());
  const location = useLocation();
  const sidebarSections = useUiStore((s) => s.sidebarSections);
  const toggleSidebarSection = useUiStore((s) => s.toggleSidebarSection);
  const settingsActive = location.pathname.startsWith('/settings');
  const settingsLink = (
    <NavLink
      to="/settings"
      onClick={onNavigate}
      aria-label={collapsed ? 'Settings' : undefined}
      aria-current={settingsActive ? 'page' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        mobile ? 'min-h-10 px-2.5 py-2' : 'px-2.5 py-1.5',
        collapsed && 'justify-center px-0 py-2',
        settingsActive && 'bg-sidebar-accent text-sidebar-accent-foreground',
      )}
    >
      <Settings className="h-4 w-4" />
      {!collapsed && <span>Settings</span>}
    </NavLink>
  );

  return (
    <>
      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-2" aria-label={mobile ? 'Mobile navigation' : 'Primary navigation'}>
          {navSections
            .filter((section) => !section.adminOnly || isAdmin)
            .map((section, si) => {
              const visibleItems = section.items.filter((item) => !item.adminOnly || isAdmin);
              if (visibleItems.length === 0) return null;
              const expanded = sidebarSections[section.id];
              const activeItem = visibleItems.find(item => location.pathname === item.to || location.pathname.startsWith(item.to + '/'));
              const contentId = `${mobile ? 'mobile' : 'desktop'}-${section.id}-navigation`;
              const renderItem = (item: (typeof visibleItems)[number]) => {
                const isActive = location.pathname === item.to || location.pathname.startsWith(item.to + '/');
                const link = (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    onClick={onNavigate}
                    aria-label={collapsed ? item.label : undefined}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md text-sm transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      mobile ? 'min-h-10 px-2.5 py-2' : 'px-2.5 py-1.5',
                      collapsed && 'justify-center px-0 py-2',
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground',
                    )}
                  >
                    <item.icon className={cn('h-4 w-4 shrink-0', isActive && 'text-primary')} />
                    {!collapsed && <span>{item.label}</span>}
                  </NavLink>
                );

                if (collapsed) {
                  return (
                    <Tooltip key={item.to}>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right" className="font-medium">
                        {item.label}
                      </TooltipContent>
                    </Tooltip>
                  );
                }
                return link;
              };

              return (
                <div key={section.id}>
                  {si > 0 && !mobile && <Separator className="my-2 bg-sidebar-border" />}
                  {!collapsed && (
                    <button
                      type="button"
                      aria-expanded={expanded}
                      aria-controls={contentId}
                      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${section.label} section`}
                      onClick={() => toggleSidebarSection(section.id)}
                      className={cn(
                        'flex w-full items-center justify-between rounded-md px-2 py-1 text-left text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/55 hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        mobile && 'min-h-9',
                      )}
                    >
                      <span>{section.label}</span>
                      {expanded
                        ? <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
                        : <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />}
                    </button>
                  )}
                  <div id={contentId} hidden={!collapsed && !expanded} className="space-y-1">
                    {(collapsed || expanded) && visibleItems.map(renderItem)}
                  </div>
                  {!collapsed && !expanded && activeItem && (
                    <div className="space-y-1" data-active-section-destination={section.id}>
                      {renderItem(activeItem)}
                    </div>
                  )}
                </div>
              );
            })}
        </nav>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2 space-y-1">
        {collapsed ? (
          <Tooltip>
            <TooltipTrigger asChild>{settingsLink}</TooltipTrigger>
            <TooltipContent side="right" className="font-medium">Settings</TooltipContent>
          </Tooltip>
        ) : settingsLink}

        {!mobile && <DesktopSidebarFooter collapsed={collapsed} />}
        {mobile && <VersionLinks collapsed={false} />}
      </div>
    </>
  );
}

function VersionLinks({ collapsed }: { collapsed: boolean }) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 pt-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <p className="px-1 text-center text-[9px] font-mono-data text-sidebar-foreground/35 truncate cursor-default">v{APP_VERSION}</p>
          </TooltipTrigger>
          <TooltipContent side="right" className="font-mono-data text-xs">{APP_VERSION_LABEL}</TooltipContent>
        </Tooltip>
        <div className="flex items-center gap-1">
          <ExternalNavLinks compact />
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2 px-2.5 pt-1 pb-0.5">
      <p className="min-w-0 flex-1 truncate text-[10px] font-mono-data text-sidebar-foreground/40" title={APP_VERSION_LABEL}>{APP_VERSION_LABEL}</p>
      <ExternalNavLinks />
    </div>
  );
}

function ExternalNavLinks({ compact = false }: { compact?: boolean }) {
  const linkClass = cn(
    'shrink-0 rounded text-sidebar-foreground/40 transition-colors hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
    compact ? 'p-1' : 'p-2 md:p-1',
  );
  return (
    <>
      <a href={APP_REPOSITORY_URL} target="_blank" rel="noopener noreferrer" aria-label="Open TS6 Manager repository on GitHub" title="View TS6 Manager on GitHub" className={linkClass}>
        <Github className="h-3.5 w-3.5" />
      </a>
      <a href={APP_DOCUMENTATION_URL} target="_blank" rel="noopener noreferrer" aria-label="Open TS6 Manager documentation" title="Open TS6 Manager documentation" className={linkClass}>
        <BookOpen className="h-3.5 w-3.5" />
      </a>
    </>
  );
}

function DesktopSidebarFooter({ collapsed }: { collapsed: boolean }) {
  const { toggleSidebar } = useUiStore();
  return (
    <>
      <button
        onClick={toggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className={cn(
          'flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 transition-colors w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          collapsed && 'justify-center px-0 py-2',
        )}
      >
        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
        {!collapsed && <span>Collapse</span>}
      </button>
      <VersionLinks collapsed={collapsed} />
    </>
  );
}

function Logo({ compact = false, onNavigate }: { compact?: boolean; onNavigate?: () => void }) {
  return (
    <NavLink
      to="/dashboard"
      onClick={onNavigate}
      aria-label="TS6 Manager dashboard"
      title={compact ? 'TS6 Manager dashboard' : undefined}
      className={cn(
        'flex items-center gap-2.5 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        compact && 'justify-center',
      )}
    >
      <BrandMark className="h-7 w-7 text-primary" />
      {!compact && (
        <div>
          <span className="text-sm font-semibold text-sidebar-accent-foreground">TS6</span>
          <span className="text-sm text-sidebar-foreground ml-1">Manager</span>
        </div>
      )}
    </NavLink>
  );
}

export function Sidebar() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'relative hidden pb-[env(safe-area-inset-bottom)] flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300 ease-in-out lg:flex',
          sidebarCollapsed ? 'w-16' : 'w-56',
        )}
      >
        <div className={cn('flex items-center h-14 px-4 border-b border-sidebar-border', sidebarCollapsed && 'justify-center px-0')}>
          <Logo compact={sidebarCollapsed} />
        </div>
        <NavigationContent collapsed={sidebarCollapsed} />
      </aside>
    </TooltipProvider>
  );
}

export function MobileNavigation() {
  const [open, setOpen] = useState(false);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="h-10 w-10 shrink-0 lg:hidden" aria-label="Open navigation menu" title="Open navigation menu">
          <Menu className="h-5 w-5" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <SheetTitle className="sr-only">TS6 Manager navigation</SheetTitle>
        <SheetDescription className="sr-only">Choose a page to navigate to.</SheetDescription>
        <div className="flex min-h-14 items-center border-b border-sidebar-border px-4 pr-14 pt-[env(safe-area-inset-top)]">
          <Logo onNavigate={() => setOpen(false)} />
        </div>
        <TooltipProvider delayDuration={0}>
          <NavigationContent mobile onNavigate={() => setOpen(false)} />
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
