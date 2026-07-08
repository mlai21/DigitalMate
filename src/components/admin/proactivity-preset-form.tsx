export function ProactivityPresetForm() {
  return (
    <form action="/api/admin/settings" method="post">
      <input type="hidden" name="proactivityPreset" value="low" />
      <button className="secondary-button compact" type="submit">
        降低主动程度
      </button>
    </form>
  );
}
