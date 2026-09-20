import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Server, Hash, Users, Shield, ShieldCheck,
  Lock, Ban, KeyRound, FolderOpen, MessageSquareWarning, Mail,
  ScrollText, Settings, Bot, Cpu, ChevronLeft, ChevronRight, Music, ListMusic, Tv, Github, BookOpen, Menu,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui.store';
import { useAuthStore } from '@/stores/auth.store';
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { APP_DOCUMENTATION_URL, APP_REPOSITORY_URL, APP_VERSION, APP_VERSION_LABEL } from '@/lib/app-version';

const navSections = [
  {
    label: 'Overview',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard' },
      { to: '/servers', icon: Server, label: 'Virtual Servers', adminOnly: true },
    ],
  },
  {
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
    label: 'Security',
    adminOnly: true,
    items: [
      { to: '/bans', icon: Ban, label: 'Bans', adminOnly: true },
      { to: '/tokens', icon: KeyRound, label: 'Tokens', adminOnly: true },
    ],
  },
  {
    label: 'Content',
    adminOnly: true,
    items: [
      { to: '/files', icon: FolderOpen, label: 'Files', adminOnly: true },
      { to: '/complaints', icon: MessageSquareWarning, label: 'Complaints', adminOnly: true },
      { to: '/messages', icon: Mail, label: 'Messages', adminOnly: true },
    ],
  },
  {
    label: 'System',
    adminOnly: true,
    items: [
      { to: '/logs', icon: ScrollText, label: 'Server Logs', adminOnly: true },
      { to: '/instance', icon: Cpu, label: 'Instance', adminOnly: true },
      { to: '/music-requests', icon: ListMusic, label: 'Music Request History', adminOnly: true },
    ],
  },
  {
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

  return (
    <>
      <ScrollArea className="flex-1 py-2">
        <nav className="space-y-1 px-2" aria-label={mobile ? 'Mobile navigation' : 'Primary navigation'}>
          {navSections
            .filter((section) => !section.adminOnly || isAdmin)
            .map((section, si) => {
              const visibleItems = section.items.filter((item) => !item.adminOnly || isAdmin);
              if (visibleItems.length === 0) return null;
              return (
                <div key={section.label}>
                  {si > 0 && <Separator className="my-2 bg-sidebar-border" />}
                  {!collapsed && (
                    <p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/40">
                      {section.label}
                    </p>
                  )}
                  {visibleItems.map((item) => {
                    const isActive = location.pathname === item.to || location.pathname.startsWith(item.to + '/');
                    const link = (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onClick={onNavigate}
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
                  })}
                </div>
              );
            })}
        </nav>
      </ScrollArea>

      <div className="border-t border-sidebar-border p-2 space-y-1">
        <NavLink
          to="/settings"
          onClick={onNavigate}
          className={cn(
            'flex items-center gap-2.5 rounded-md text-sm text-sidebar-foreground hover:bg-sidebar-accent/50 hover:text-sidebar-accent-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            mobile ? 'min-h-10 px-2.5 py-2' : 'px-2.5 py-1.5',
            collapsed && 'justify-center px-0 py-2',
            location.pathname.startsWith('/settings') && 'bg-sidebar-accent text-sidebar-accent-foreground',
          )}
        >
          <Settings className="h-4 w-4" />
          {!collapsed && <span>Settings</span>}
        </NavLink>

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

function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn('flex items-center gap-2.5', compact && 'justify-center')}>
      <div className="h-7 w-7 rounded-md bg-primary/20 flex items-center justify-center">
        <span className="text-primary font-bold text-xs font-mono-data">TS</span>
      </div>
      {!compact && (
        <div>
          <span className="text-sm font-semibold text-sidebar-accent-foreground">TS6</span>
          <span className="text-sm text-sidebar-foreground ml-1">Manager</span>
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const sidebarCollapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <TooltipProvider delayDuration={0}>
      <aside
        className={cn(
          'relative hidden flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground transition-all duration-300 ease-in-out lg:flex',
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
          <Logo />
        </div>
        <TooltipProvider delayDuration={0}>
          <NavigationContent mobile onNavigate={() => setOpen(false)} />
        </TooltipProvider>
      </SheetContent>
    </Sheet>
  );
}
