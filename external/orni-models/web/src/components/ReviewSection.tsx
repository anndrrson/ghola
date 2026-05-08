"use client";

import { useState, useEffect } from "react";
import { getModelReviews, submitReview, type ReviewWithUser } from "@/lib/api";
import { Star, Send, Loader2 } from "lucide-react";
import StarRating from "./StarRating";

interface ReviewSectionProps {
  slug: string;
  authenticated: boolean;
}

export default function ReviewSection({ slug, authenticated }: ReviewSectionProps) {
  const [reviews, setReviews] = useState<ReviewWithUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [hoverRating, setHoverRating] = useState(0);
  const [selectedRating, setSelectedRating] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [submitSuccess, setSubmitSuccess] = useState(false);

  useEffect(() => {
    getModelReviews(slug)
      .then(setReviews)
      .catch(() => setReviews([]))
      .finally(() => setLoading(false));
  }, [slug]);

  async function handleSubmit() {
    if (selectedRating === 0 || submitting) return;

    setSubmitting(true);
    setSubmitError("");
    setSubmitSuccess(false);

    try {
      await submitReview(slug, selectedRating, reviewText || undefined);
      setSubmitSuccess(true);
      setSelectedRating(0);
      setReviewText("");

      // Refresh reviews list
      const updated = await getModelReviews(slug);
      setReviews(updated);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to submit review");
    } finally {
      setSubmitting(false);
    }
  }

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }

  const activeRating = hoverRating || selectedRating;

  return (
    <div className="bg-[#141414] border border-[#262626] rounded-lg p-6">
      <h3 className="mb-4 text-lg font-medium text-[#fafafa]">Reviews</h3>

      {/* Submit form */}
      {authenticated && (
        <div className="mb-6 rounded-lg bg-[#1a1a1a] border border-[#262626] p-4">
          <p className="mb-3 text-sm font-medium text-[#a1a1a1]">Rate this model</p>

          {/* Interactive star picker */}
          <div className="mb-3 flex items-center gap-1">
            {[1, 2, 3, 4, 5].map((star) => (
              <button
                key={star}
                type="button"
                onMouseEnter={() => setHoverRating(star)}
                onMouseLeave={() => setHoverRating(0)}
                onClick={() => setSelectedRating(star)}
                className="transition-colors"
              >
                <Star
                  className={`h-6 w-6 ${
                    star <= activeRating
                      ? "text-yellow-400 fill-yellow-400"
                      : "text-[#666]"
                  }`}
                />
              </button>
            ))}
            {activeRating > 0 && (
              <span className="ml-2 text-sm text-[#a1a1a1]">
                {activeRating}/5
              </span>
            )}
          </div>

          {/* Text input */}
          <textarea
            value={reviewText}
            onChange={(e) => setReviewText(e.target.value)}
            placeholder="Share your experience (optional)"
            rows={3}
            className="mb-3 w-full resize-none rounded-lg bg-[#141414] border border-[#262626] px-3 py-2 text-sm text-[#fafafa] placeholder-[#666] outline-none transition-colors focus:border-[#444]"
          />

          {/* Submit button */}
          <div className="flex items-center gap-3">
            <button
              onClick={handleSubmit}
              disabled={selectedRating === 0 || submitting}
              className="flex items-center gap-2 rounded-lg bg-[#fafafa] px-4 py-2 text-sm font-medium text-[#0a0a0a] transition-colors hover:bg-[#e5e5e5] disabled:opacity-50 active:scale-[0.98]"
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Submit Review
            </button>

            {submitError && (
              <p className="text-sm text-[#ef4444]">{submitError}</p>
            )}
            {submitSuccess && (
              <p className="text-sm text-[#00E5A0]">Review submitted!</p>
            )}
          </div>
        </div>
      )}

      {/* Reviews list */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#262626] border-t-[#a1a1a1]" />
        </div>
      )}

      {!loading && reviews.length === 0 && (
        <p className="py-6 text-center text-sm text-[#666]">
          No reviews yet. Be the first to review this model.
        </p>
      )}

      {!loading && reviews.length > 0 && (
        <div className="space-y-4">
          {reviews.map((review) => (
            <div
              key={review.id}
              className="border-b border-[#1a1a1a] pb-4 last:border-0 last:pb-0"
            >
              <div className="mb-1.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[#a1a1a1]">
                    {review.user_name || "Anonymous"}
                  </span>
                  <StarRating rating={review.rating} size="sm" />
                </div>
                <span className="text-xs text-[#666]">
                  {formatDate(review.created_at)}
                </span>
              </div>
              {review.review_text && (
                <p className="text-sm leading-relaxed text-[#a1a1a1]">
                  {review.review_text}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
