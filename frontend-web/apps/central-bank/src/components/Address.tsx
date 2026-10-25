/** A strkey, shortened, with the full address on hover; a name first when there is one. */
export function Address(props: { address: string; name?: string | undefined }) {
  const short = `${props.address.slice(0, 4)}…${props.address.slice(-4)}`;
  return (
    <span className="address" title={props.address}>
      {props.name ? (
        <>
          {props.name} <span className="muted mono">{short}</span>
        </>
      ) : (
        <span className="mono">{short}</span>
      )}
    </span>
  );
}
