export function StatusNote({ children }: { readonly children: string }) {
  return <output className="block text-sm text-foreground/80">{children}</output>;
}
