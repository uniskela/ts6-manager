export function StatusNote({ children }: { readonly children: string }) {
  return <output className="block text-sm text-muted-foreground">{children}</output>;
}
