export interface DirectoryClient {
  clid: number;
  uniqueId: string;
  nickname: string;
  channelId: number;
  isQuery: boolean;
}

export interface DirectoryEvent {
  type: "enter" | "leave" | "move";
  client: DirectoryClient;
}

interface Cmd {
  name: string;
  params: Record<string, string>;
  groups?: Record<string, string>[];
}

/**
 * Tracks TeamSpeak clients from the command stream. Slots are keyed on the uniqueId, never on the
 * display name. Shared fields (ctid, cfid) are sent only on the first entry of a piped list.
 */
export class ClientDirectory {
  private readonly byClid = new Map<number, DirectoryClient>();

  ingest(cmd: Cmd): DirectoryEvent[] {
    const events: DirectoryEvent[] = [];
    switch (cmd.name) {
      case "notifycliententerview":
      case "clientlist": {
        const entries = cmd.groups ?? [cmd.params];
        const first = cmd.params;
        for (const e of entries) {
          const clid = parseInt(e.clid || "0", 10);
          const uid = e.client_unique_identifier;
          if (!clid || !uid) continue;
          const client: DirectoryClient = {
            clid,
            uniqueId: uid,
            nickname: e.client_nickname ?? "",
            channelId: parseInt(e.ctid || e.cid || first.ctid || first.cid || "0", 10),
            isQuery: String(e.client_type) === "1",
          };
          this.byClid.set(clid, client);
          events.push({ type: "enter", client });
        }
        break;
      }
      case "notifyclientleftview": {
        const entries = cmd.groups ?? [cmd.params];
        for (const e of entries) {
          const clid = parseInt(e.clid || "0", 10);
          const client = this.byClid.get(clid);
          if (client) {
            this.byClid.delete(clid);
            events.push({ type: "leave", client });
          }
        }
        break;
      }
      case "notifyclientmoved": {
        const entries = cmd.groups ?? [cmd.params];
        const first = cmd.params;
        for (const e of entries) {
          const clid = parseInt(e.clid || "0", 10);
          const client = this.byClid.get(clid);
          if (client) {
            // ctid is sent once on the first entry of a piped list; later entries inherit it.
            client.channelId = parseInt(e.ctid || first.ctid || "0", 10);
            events.push({ type: "move", client });
          }
        }
        break;
      }
      case "notifyclientupdated": {
        const client = this.byClid.get(parseInt(cmd.params.clid || "0", 10));
        if (client && cmd.params.client_nickname !== undefined) client.nickname = cmd.params.client_nickname;
        break;
      }
    }
    return events;
  }

  byClientId(clid: number): DirectoryClient | undefined {
    return this.byClid.get(clid);
  }

  inChannel(channelId: number): DirectoryClient[] {
    return [...this.byClid.values()].filter((c) => c.channelId === channelId && !c.isQuery);
  }
}
