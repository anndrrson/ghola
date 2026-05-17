interface AgentAvatarProps {
  avatar: string;
  name: string;
  color: string;
  size?: "sm" | "md" | "lg";
}

const sizes = {
  sm: "h-8 w-8 text-sm",
  md: "h-10 w-10 text-lg",
  lg: "h-14 w-14 text-2xl",
};

export function AgentAvatar({ avatar, name, color, size = "md" }: AgentAvatarProps) {
  const isEmoji = /\p{Emoji}/u.test(avatar);

  return (
    <div
      className={`${sizes[size]} rounded-full flex items-center justify-center shrink-0`}
      style={{ backgroundColor: isEmoji ? `${color}20` : color }}
    >
      {isEmoji ? (
        <span>{avatar}</span>
      ) : (
        <span className="font-bold text-[#eef1f8]">
          {name.charAt(0).toUpperCase()}
        </span>
      )}
    </div>
  );
}
