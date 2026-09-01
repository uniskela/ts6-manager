import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ConnectionSetupHelpDialog } from '@/components/connections/ConnectionSetupHelpDialog';
import { BookOpen, HelpCircle } from 'lucide-react';

interface ConnectionSetupGuideProps {
  hasConnections: boolean;
  hasSshOnAnyConnection: boolean;
  webqueryTestPassed?: boolean;
  onStartWizard: () => void;
}

/** Thin help entry — only shown once at least one connection exists. */
export function ConnectionSetupGuide({
  hasConnections,
  hasSshOnAnyConnection,
  webqueryTestPassed,
  onStartWizard,
}: ConnectionSetupGuideProps) {
  const [helpOpen, setHelpOpen] = useState(false);

  if (!hasConnections) return null;

  return (
    <>
      <Card>
        <CardContent className="py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <BookOpen className="h-4 w-4 shrink-0" />
            <span>Need help with connections?</span>
          </div>
          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setHelpOpen(true)}>
            <HelpCircle className="h-3 w-3 mr-1" /> Help
          </Button>
        </CardContent>
      </Card>

      <ConnectionSetupHelpDialog
        open={helpOpen}
        onOpenChange={setHelpOpen}
        hasConnections={hasConnections}
        hasSshOnAnyConnection={hasSshOnAnyConnection}
        webqueryTestPassed={webqueryTestPassed}
        onStartWizard={onStartWizard}
      />
    </>
  );
}
