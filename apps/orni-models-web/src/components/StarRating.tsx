import { Star } from "lucide-react";

interface StarRatingProps {
  rating: number;
  size?: "sm" | "md";
}

export default function StarRating({ rating, size = "sm" }: StarRatingProps) {
  const sizeClass = size === "sm" ? "h-3.5 w-3.5" : "h-5 w-5";

  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => {
        const fill = Math.min(1, Math.max(0, rating - (star - 1)));

        if (fill >= 1) {
          // Fully filled
          return (
            <Star
              key={star}
              className={`${sizeClass} text-yellow-400 fill-yellow-400`}
            />
          );
        }

        if (fill <= 0) {
          // Empty
          return (
            <Star
              key={star}
              className={`${sizeClass} text-gray-600`}
            />
          );
        }

        // Partial fill — use a clipped overlay
        return (
          <div key={star} className={`relative ${sizeClass}`}>
            <Star className={`absolute inset-0 ${sizeClass} text-gray-600`} />
            <div
              className="absolute inset-0 overflow-hidden"
              style={{ width: `${fill * 100}%` }}
            >
              <Star className={`${sizeClass} text-yellow-400 fill-yellow-400`} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
