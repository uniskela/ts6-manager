export interface DirectoryClient {
  clid: number;
  uniqueId: string;
  nickname: string;
  channelId: number;
  isQuery: boolean;
}

export interface DirectoryEvent {
  type: "enter" | "leave" | "move" | "nick";
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
    switch (cmd.name) {
      case "notifycliententerview":
      case "clientlist":
        return this.enterList(cmd);
      case "notifyclientleftview":
        return this.leaveList(cmd);
      case "notifyclientmoved":
        return this.moveList(cmd);
      case "notifyclientupdated": {
        const nick = this.nickEvent(cmd.params);
        return nick ? [nick] : [];
      }
      default:
        return [];
    }
  }

  private enterList(cmd: Cmd): DirectoryEvent[] {
    const events: DirectoryEvent[] = [];
    const first = cmd.params;
    for (const e of cmd.groups ?? [cmd.params]) {
      const clid = Number.parseInt(e.clid || "0", 10);
      const uid = e.client_unique_identifier;
      if (!clid || !uid) continue;
      const client: DirectoryClient = {
        clid,
        uniqueId: uid,
        nickname: e.client_nickname ?? "",
        channelId: Number.parseInt(e.ctid || e.cid || first.ctid || first.cid || "0", 10),
        isQuery: String(e.client_type) === "1",
      };
      this.byClid.set(clid, client);
      events.push({ type: "enter", client });
    }
    return events;
  }

  private leaveList(cmd: Cmd): DirectoryEvent[] {
    const events: DirectoryEvent[] = [];
    for (const e of cmd.groups ?? [cmd.params]) {
      const clid = Number.parseInt(e.clid || "0", 10);
      const client = this.byClid.get(clid);
      if (!client) continue;
      this.byClid.delete(clid);
      events.push({ type: "leave", client });
    }
    return events;
  }

  private moveList(cmd: Cmd): DirectoryEvent[] {
    const events: DirectoryEvent[] = [];
    const first = cmd.params;
    for (const e of cmd.groups ?? [cmd.params]) {
      const clid = Number.parseInt(e.clid || "0", 10);
      const client = this.byClid.get(clid);
      if (!client) continue;
      // ctid is sent once on the first entry of a piped list; later entries inherit it.
      client.channelId = Number.parseInt(e.ctid || first.ctid || "0", 10);
      events.push({ type: "move", client });
    }
    return events;
  }

  private nickEvent(params: Record<string, string>): DirectoryEvent | null {
    const client = this.byClid.get(Number.parseInt(params.clid || "0", 10));
    if (!client || params.client_nickname === undefined || client.nickname === params.client_nickname) return null;
    client.nickname = params.client_nickname;
    return { type: "nick", client };
  }

  byClientId(clid: number): DirectoryClient | undefined {
    return this.byClid.get(clid);
  }

  inChannel(channelId: number): DirectoryClient[] {
    return [...this.byClid.values()].filter((c) => c.channelId === channelId && !c.isQuery);
  }
}
