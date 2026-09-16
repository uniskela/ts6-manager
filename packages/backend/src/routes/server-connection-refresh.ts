interface BotFlowLookup {
  botFlow: {
    findMany(args: {
      where: { serverConfigId: number; enabled: true };
      select: { id: true };
    }): Promise<Array<{ id: number }>>;
  };
}

interface ReloadableBotEngine {
  reloadFlow(flowId: number): Promise<void>;
}

/**
 * Restart enabled flows bound to a server after its connection client is replaced.
 * Long-running flow state such as animated-channel timers captures connection state
 * when it starts, so reloading ensures it binds to the refreshed WebQuery client.
 */
export async function reloadEnabledServerFlows(
  prisma: BotFlowLookup,
  botEngine: ReloadableBotEngine,
  serverConfigId: number,
): Promise<void> {
  const flows = await prisma.botFlow.findMany({
    where: { serverConfigId, enabled: true },
    select: { id: true },
  });

  for (const flow of flows) {
    await botEngine.reloadFlow(flow.id);
  }
}
