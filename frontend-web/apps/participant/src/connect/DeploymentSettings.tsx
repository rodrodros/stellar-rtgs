// Runtime overrides for the selected network: its RPC, the settlement contract and the central
// bank. The devnet is reset often, so its contract id changes; the central bank's account
// usually finds it without help.
import type { NetworkConfig, NetworkOverrides } from "@rtgs/core";
import { useState } from "react";

const FIELDS: { key: keyof NetworkOverrides; label: string }[] = [
  { key: "rpcUrl", label: "RPC URL" },
  { key: "contractId", label: "Settlement contract id" },
  { key: "centralBank", label: "Central bank account" },
];

export function DeploymentSettings(props: { network: NetworkConfig; overrides: NetworkOverrides; onSave: (o: NetworkOverrides) => void }) {
  const [draft, setDraft] = useState<NetworkOverrides>(props.overrides);
  return (
    <details className="settings">
      <summary>Deployment settings ({props.network.label})</summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const cleaned: NetworkOverrides = {};
          for (const { key } of FIELDS) {
            const value = draft[key]?.trim();
            if (value) cleaned[key] = value;
          }
          props.onSave(cleaned);
        }}
      >
        {FIELDS.map(({ key, label }) => (
          <label key={key}>
            {label}
            <input value={draft[key] ?? ""} placeholder={props.network[key] ?? "(default)"} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
          </label>
        ))}
        <div className="row">
          <button type="submit">Save and reconnect</button>
          <button
            type="button"
            onClick={() => {
              setDraft({});
              props.onSave({});
            }}
          >
            Reset to defaults
          </button>
        </div>
      </form>
    </details>
  );
}
