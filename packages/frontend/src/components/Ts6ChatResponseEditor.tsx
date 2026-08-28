import { useCallback, useRef, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronRight,
  Code,
  Code2,
  EyeOff,
  FunctionSquare,
  Heading,
  Highlighter,
  Italic,
  Link,
  Link2,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Network,
  Pilcrow,
  Strikethrough,
  Subscript,
  Superscript,
  Table,
  Underline,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  insertAtCursor,
  insertBlock,
  prefixLines,
  wrapSelection,
  type TextSelection,
} from '@/lib/ts6-format-insert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

interface Ts6ChatResponseEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  id?: string;
}

function ToolbarIconButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
      onClick={onClick}
      title={label}
      aria-label={label}
    >
      {children}
    </Button>
  );
}

function ToolbarMenuTrigger({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <DropdownMenuTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-0.5 px-1.5 text-muted-foreground hover:text-foreground"
        title={label}
        aria-label={label}
      >
        {children}
        <ChevronRight className="h-3 w-3 opacity-60" />
      </Button>
    </DropdownMenuTrigger>
  );
}

export function Ts6ChatResponseEditor({
  value,
  onChange,
  placeholder,
  rows = 8,
  className,
  id,
}: Ts6ChatResponseEditorProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const getSelection = (): TextSelection => {
    const el = textareaRef.current;
    if (!el) return { start: value.length, end: value.length };
    return { start: el.selectionStart, end: el.selectionEnd };
  };

  const applyEdit = useCallback(
    (fn: (value: string, sel: TextSelection) => { value: string; selection: TextSelection }) => {
      const el = textareaRef.current;
      const sel = getSelection();
      const result = fn(value, sel);
      onChange(result.value);
      requestAnimationFrame(() => {
        if (!el) return;
        el.focus();
        el.setSelectionRange(result.selection.start, result.selection.end);
      });
    },
    [value, onChange],
  );

  const wrap = (before: string, after: string, placeholder?: string) =>
    applyEdit((v, s) => wrapSelection(v, s, before, after, placeholder));

  const prefix = (pfx: string, placeholder?: string) =>
    applyEdit((v, s) => prefixLines(v, s, pfx, placeholder));

  const insert = (text: string, selectInserted?: boolean) =>
    applyEdit((v, s) => insertAtCursor(v, s, text, selectInserted));

  const block = (text: string) => applyEdit((v, s) => insertBlock(v, s, text));

  return (
    <div
      className={cn(
        'rounded-md border border-border/80 bg-background shadow-sm ring-1 ring-primary/10 focus-within:ring-primary/30 transition-shadow',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border/60 bg-muted/30 px-1.5 py-1">
        <ToolbarIconButton label="Bold" onClick={() => wrap('**', '**', 'bold')}>
          <Bold className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Italic" onClick={() => wrap('*', '*', 'italic')}>
          <Italic className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Strikethrough" onClick={() => wrap('~~', '~~', 'strike')}>
          <Strikethrough className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Underline" onClick={() => wrap('<u>', '</u>', 'underline')}>
          <Underline className="h-3.5 w-3.5" />
        </ToolbarIconButton>

        <div className="mx-0.5 h-4 w-px bg-border/80" />

        <ToolbarIconButton
          label="Link"
          onClick={() => wrap('[', '](https://example.com)', 'link text')}
        >
          <Link className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Blockquote" onClick={() => prefix('> ', 'quote')}>
          <Pilcrow className="h-3.5 w-3.5" />
        </ToolbarIconButton>
        <ToolbarIconButton label="Inline code" onClick={() => wrap('`', '`', 'code')}>
          <Code className="h-3.5 w-3.5" />
        </ToolbarIconButton>

        <DropdownMenu>
          <ToolbarMenuTrigger label="Lists">
            <List className="h-3.5 w-3.5" />
          </ToolbarMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            <DropdownMenuItem onClick={() => prefix('- ', 'item')}>
              <List className="h-4 w-4" />
              Bulleted list
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => prefix('1. ', 'item')}>
              <ListOrdered className="h-4 w-4" />
              Numbered list
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => prefix('- [ ] ', 'task')}>
              <ListTodo className="h-4 w-4" />
              Checklist
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <ToolbarMenuTrigger label="Spoiler">
            <EyeOff className="h-3.5 w-3.5" />
          </ToolbarMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[11rem]">
            <DropdownMenuItem onClick={() => wrap('||', '||', 'spoiler')}>
              Inline spoiler
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => wrap('[spoiler]', '[/spoiler]', 'hidden text')}
            >
              BBCode spoiler
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                block('<details>\n<summary>Spoiler title</summary>\n\nHidden content\n</details>')
              }
            >
              Details / summary block
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <ToolbarMenuTrigger label="Headings">
            <Heading className="h-3.5 w-3.5" />
          </ToolbarMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[10rem]">
            <DropdownMenuItem onClick={() => prefix('# ', 'Heading 1')}>
              Heading 1
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => prefix('## ', 'Heading 2')}>
              Heading 2
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => prefix('### ', 'Heading 3')}>
              Heading 3
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => block('Setext title\n==============')}
            >
              Setext H1
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => block('Setext title\n--------------')}>
              Setext H2
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <ToolbarMenuTrigger label="Others">
            <span className="text-[11px] font-medium">Others</span>
          </ToolbarMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-[12rem]">
            <DropdownMenuItem
              onClick={() => block('```\ncode block\n```')}
            >
              <Code2 className="h-4 w-4" />
              Code block
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => insert('[^1]', true)}>
              <Superscript className="h-4 w-4" />
              Footnote ref
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => block('[^1]: Footnote text')}>
              <Subscript className="h-4 w-4" />
              Footnote definition
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Links</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => insert('https://example.com', true)}>
              <Link2 className="h-4 w-4" />
              Autolink URL
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => wrap('[', '][ref]', 'link text')}
            >
              Reference link
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => block('[ref]: https://example.com')}>
              Reference definition
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Math</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => wrap('$', '$', 'x^2')}>
              <FunctionSquare className="h-4 w-4" />
              Inline math
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => block('$$\nx = \\frac{-b}{2a}\n$$')}>
              Block math
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs text-muted-foreground">Align</DropdownMenuLabel>
            <DropdownMenuItem onClick={() => wrap('[left]', '[/left]', 'text')}>
              <AlignLeft className="h-4 w-4" />
              Left
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('[center]', '[/center]', 'text')}>
              <AlignCenter className="h-4 w-4" />
              Center
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('[right]', '[/right]', 'text')}>
              <AlignRight className="h-4 w-4" />
              Right
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('[justify]', '[/justify]', 'text')}>
              <AlignJustify className="h-4 w-4" />
              Justify
            </DropdownMenuItem>

            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() =>
                block('```mermaid\nflowchart LR\n  A --> B\n```')
              }
            >
              <Network className="h-4 w-4" />
              Mermaid diagram
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('==', '==', 'highlight')}>
              <Highlighter className="h-4 w-4" />
              Highlight
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                block('| Col 1 | Col 2 |\n| --- | --- |\n| A | B |')
              }
            >
              <Table className="h-4 w-4" />
              Table
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => insert('\n---\n')}>
              <Minus className="h-4 w-4" />
              Thematic break
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('![alt](', ')', 'https://example.com/image.png')}>
              Image
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => wrap('[b]', '[/b]', 'bold')}>
              BBCode bold
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => wrap('[color=#ff6600]', '[/color]', 'colored')}
            >
              BBCode color
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="flex min-h-[120px] w-full resize-y rounded-none border-0 bg-transparent px-3 py-2 font-mono text-xs shadow-none placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-0"
      />
    </div>
  );
}
