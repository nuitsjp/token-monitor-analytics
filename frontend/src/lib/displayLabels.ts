export function cycleTypeLabel(value: string): string {
  return (
    (
      {
        daily: "日次",
        weekly: "週次",
        monthly: "月次",
        billing: "請求期間",
        rolling: "ローリング",
        session: "セッション",
      } as Record<string, string>
    )[value] ?? value
  );
}
