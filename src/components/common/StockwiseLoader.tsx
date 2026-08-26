export function StockwiseLoader({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizeClass = size === "lg" ? "stockwise-loader-lg" : "stockwise-loader";
  return (
    <div className="flex items-center justify-center p-8">
      <div className={sizeClass} />
    </div>
  );
}
