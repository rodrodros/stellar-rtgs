// Devnet, testnet or (when this build enables it) mainnet. Mainnet always asks first: the
// user types "mainnet", and nothing restores it without asking again.
import type { NetworkConfig, NetworkId } from "@rtgs/core";
import { useState } from "react";
import { ConfirmDialog } from "../ui/ConfirmDialog.tsx";

export function NetworkSwitcher(props: {
  networks: NetworkConfig[];
  current: NetworkId;
  onSelect: (id: NetworkId, acknowledgeMainnet: boolean) => void;
}) {
  const [asking, setAsking] = useState(false);
  return (
    <>
      <label className="inline">
        Network
        <select
          value={props.current}
          onChange={(e) => {
            const id = e.target.value as NetworkId;
            if (id === "mainnet") setAsking(true);
            else props.onSelect(id, false);
          }}
        >
          {props.networks.map((n) => (
            <option key={n.id} value={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      {asking && (
        <ConfirmDialog
          title="Switch to mainnet?"
          phrase="mainnet"
          confirmLabel="Use mainnet"
          onCancel={() => setAsking(false)}
          onConfirm={() => {
            setAsking(false);
            props.onSelect("mainnet", true);
          }}
        >
          <p>On mainnet every deposit, payment order and repayment moves real funds, signed by your wallet.</p>
        </ConfirmDialog>
      )}
    </>
  );
}
