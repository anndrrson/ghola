'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Sparkles, Check } from 'lucide-react';
import { createModel, addContent } from "@/lib/api";

const STEPS = ['Basics', 'System Prompt', 'Content', 'Pricing', 'Review'];

export default function CreateModelPage() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    description: '',
    system_prompt: '',
    category: '',
    price_per_query: 100000,
    content_text: '',
    content_url: '',
  });

  const generateSlug = (name: string) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  const updateField = (field: string, value: string | number) => {
    setForm((prev) => {
      const updated = { ...prev, [field]: value };
      if (field === 'name') updated.slug = generateSlug(value as string);
      return updated;
    });
  };

  const priceDisplay = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

  const handleSubmit = async () => {
    setLoading(true);
    try {
      const model = await createModel({
        name: form.name,
        slug: form.slug,
        description: form.description || undefined,
        system_prompt: form.system_prompt,
        category: form.category || undefined,
        price_per_query: form.price_per_query,
      });
      if (form.content_text) {
        await addContent(model.id, { source_type: 'text', content_text: form.content_text });
      }
      if (form.content_url) {
        await addContent(model.id, { source_type: 'blog', source_url: form.content_url });
      }
      router.push('/models/creator');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create model';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-3xl font-bold mb-8">Create Your AI Model</h1>

      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => i < step && setStep(i)}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                i === step ? 'bg-coral-500 text-white' : i < step ? 'bg-coral-500/20 text-coral-400' : 'bg-gray-800 text-gray-500'
              }`}
            >
              {i < step ? <Check className="w-4 h-4" /> : i + 1}
            </button>
            {i < STEPS.length - 1 && <div className={`w-8 h-0.5 ${i < step ? 'bg-coral-500/50' : 'bg-gray-800'}`} />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Model Name</label>
            <input type="text" value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g., Fitness Coach AI" className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">URL Slug</label>
            <div className="flex items-center bg-gray-900 border border-gray-700 rounded-xl px-4 py-3">
              <span className="text-gray-500">kinakuta.xyz/models/</span>
              <input type="text" value={form.slug} onChange={(e) => updateField('slug', e.target.value)} className="bg-transparent text-white flex-1 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Description</label>
            <textarea value={form.description} onChange={(e) => updateField('description', e.target.value)} rows={3} placeholder="What makes your AI unique?" className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Category</label>
            <select value={form.category} onChange={(e) => updateField('category', e.target.value)} className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none">
              <option value="">Select a category</option>
              <option value="fitness">Fitness & Health</option>
              <option value="finance">Finance & Investing</option>
              <option value="tech">Tech & Programming</option>
              <option value="creative">Creative & Writing</option>
              <option value="business">Business & Marketing</option>
              <option value="education">Education</option>
              <option value="lifestyle">Lifestyle</option>
            </select>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="bg-coral-500/10 border border-coral-500/30 rounded-xl p-4 flex gap-3">
            <Sparkles className="w-5 h-5 text-coral-400 flex-shrink-0 mt-0.5" />
            <p className="text-sm text-coral-200">The system prompt defines your AI&apos;s personality. Write as if briefing someone to respond exactly like you.</p>
          </div>
          <textarea value={form.system_prompt} onChange={(e) => updateField('system_prompt', e.target.value)} rows={12} placeholder="You are [Name], a [expertise]. You speak in a [tone] way..." className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none resize-none font-mono text-sm" />
          <p className="text-sm text-gray-500">{form.system_prompt.length} characters</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <p className="text-gray-400">Add content so we can train the AI to sound like you.</p>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Paste Your Content</label>
            <textarea value={form.content_text} onChange={(e) => updateField('content_text', e.target.value)} rows={8} placeholder="Paste articles, blog posts, newsletters..." className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Blog URL (optional)</label>
            <input type="url" value={form.content_url} onChange={(e) => updateField('content_url', e.target.value)} placeholder="https://yourblog.com" className="w-full bg-gray-900 border border-gray-700 rounded-xl px-4 py-3 text-white focus:border-coral-500 focus:outline-none" />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Price per message: {priceDisplay(form.price_per_query)}</label>
            <input type="range" min={10000} max={1000000} step={10000} value={form.price_per_query} onChange={(e) => updateField('price_per_query', parseInt(e.target.value))} className="w-full accent-coral-500" />
            <div className="flex justify-between text-sm text-gray-500 mt-1"><span>$0.01</span><span>$1.00</span></div>
          </div>
          <div className="bg-gray-900 rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between text-gray-400"><span>You earn per message</span><span className="text-white">{priceDisplay(Math.floor(form.price_per_query * 0.85))}</span></div>
            <div className="flex justify-between text-gray-400"><span>Platform fee (15%)</span><span>{priceDisplay(Math.floor(form.price_per_query * 0.15))}</span></div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="bg-gray-900 rounded-xl p-6 space-y-4">
          <div><span className="text-sm text-gray-500">Name</span><p className="text-white font-medium">{form.name}</p></div>
          <div><span className="text-sm text-gray-500">URL</span><p className="text-coral-400">kinakuta.xyz/models/{form.slug}</p></div>
          <div><span className="text-sm text-gray-500">Price</span><p className="text-white">{priceDisplay(form.price_per_query)} per message</p></div>
          <div><span className="text-sm text-gray-500">System Prompt</span><p className="text-gray-300 text-sm whitespace-pre-wrap line-clamp-4">{form.system_prompt}</p></div>
          <div><span className="text-sm text-gray-500">Content</span><p className="text-gray-300 text-sm">{form.content_text ? `${form.content_text.length} chars` : 'None'}{form.content_url ? ` + ${form.content_url}` : ''}</p></div>
        </div>
      )}

      <div className="flex justify-between mt-10">
        <button onClick={() => (step === 0 ? router.back() : setStep(step - 1))} className="flex items-center gap-2 px-6 py-3 text-gray-400 hover:text-white transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => setStep(step + 1)} disabled={step === 0 && !form.name} className="flex items-center gap-2 px-6 py-3 bg-coral-500 hover:bg-coral-600 text-white rounded-xl font-medium disabled:opacity-50 transition-colors">
            Next <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={loading} className="flex items-center gap-2 px-6 py-3 bg-coral-500 hover:bg-coral-600 text-white rounded-xl font-medium disabled:opacity-50 transition-colors">
            {loading ? 'Creating...' : 'Create Model'} <Sparkles className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
