import React from "react";

interface PrimaryButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "orange" | "pink" | "outline";
  size?: "sm" | "md" | "lg";
}

export function PrimaryButton({
  children,
  variant = "orange",
  size = "md",
  className = "",
  ...props
}: PrimaryButtonProps) {
  const baseClasses =
    "inline-flex items-center justify-center font-heading font-bold transition-all cursor-pointer active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed";

  const sizeClasses = {
    sm: "text-xs px-4 py-2 rounded-lg",
    md: "text-sm px-5 py-2.5 rounded-xl",
    lg: "text-base px-7 py-3 rounded-xl",
  };

  const variantClasses = {
    orange:
      "text-white bg-brand-orange hover:bg-brand-peach hover:shadow-glow-orange shadow-sm hover:text-slate-900",
    pink: "text-white bg-brand-pink hover:bg-[#f04080] hover:shadow-glow-pink shadow-sm",
    outline:
      "text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 hover:border-slate-400 shadow-2xs",
  };

  return (
    <button
      className={`${baseClasses} ${sizeClasses[size]} ${variantClasses[variant]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}
