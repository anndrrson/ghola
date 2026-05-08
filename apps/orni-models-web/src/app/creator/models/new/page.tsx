'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Sparkles, Check } from 'lucide-react';
import { api } from '@/lib/api';

const STEPS = ['Basics', 'System Prompt', 'Pricing', 'Review'];

const BASE_MODELS = [
  { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', desc: 'Fast, efficient — great for most use cases' },
  { id: 'qwen/qwen3-32b', name: 'Qwen3 32B', desc: 'Strong reasoning and instruction following' },
  { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', desc: 'Most capable — best quality responses' },
  { id: 'meta-llama/llama-4-scout-17b-16e-instruct', name: 'Llama 4 Scout 17B', desc: 'Latest Llama 4 — fast coding and reasoning' },
];

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
    base_model: BASE_MODELS[0].id,
    price_per_query: 100000,
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
      await api.createModel({
        name: form.name,
        slug: form.slug,
        description: form.description || undefined,
        system_prompt: form.system_prompt,
        base_model: form.base_model,
        category: form.category || undefined,
        price_per_query: form.price_per_query,
      });
      router.push('/creator');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Failed to create model';
      alert(message);
    } finally {
      setLoading(false);
    }
  };

  const selectedBaseModel = BASE_MODELS.find((m) => m.id === form.base_model);

  return (
    <div className="max-w-2xl mx-auto py-12 px-4">
      <h1 className="text-3xl font-medium mb-2">Create Your AI Model</h1>
      <p className="text-[#a1a1a1] text-sm mb-8">Your model will be live immediately — just write a system prompt and go.</p>

      <div className="flex items-center gap-2 mb-10">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-2">
            <button
              onClick={() => i < step && setStep(i)}
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium transition-colors ${
                i === step ? 'bg-[#fafafa] text-[#0a0a0a]' : i < step ? 'bg-[#222] text-[#fafafa]' : 'bg-[#141414] text-[#666]'
              }`}
            >
              {i < step ? <Check className="w-4 h-4" /> : i + 1}
            </button>
            {i < STEPS.length - 1 && <div className={`w-8 h-0.5 ${i < step ? 'bg-[#333]' : 'bg-[#1a1a1a]'}`} />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">Model Name</label>
            <input type="text" value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g., Fitness Coach AI" className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">URL Slug</label>
            <div className="flex items-center bg-[#141414] border border-[#262626] rounded-lg px-4 py-3">
              <span className="text-[#666]">kinakuta.xyz/models/</span>
              <input type="text" value={form.slug} onChange={(e) => updateField('slug', e.target.value)} className="bg-transparent text-[#fafafa] flex-1 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">Description</label>
            <textarea value={form.description} onChange={(e) => updateField('description', e.target.value)} rows={3} placeholder="What makes your AI unique?" className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">Category</label>
            <select value={form.category} onChange={(e) => updateField('category', e.target.value)} className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none">
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
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">Base Model</label>
            <div className="space-y-2">
              {BASE_MODELS.map((m) => (
                <button
                  key={m.id}
                  onClick={() => updateField('base_model', m.id)}
                  className={`w-full text-left rounded-lg border p-4 transition-colors ${
                    form.base_model === m.id
                      ? 'border-[#fafafa] bg-[#1a1a1a]'
                      : 'border-[#262626] bg-[#141414] hover:border-[#333]'
                  }`}
                >
                  <p className="font-medium text-[#fafafa]">{m.name}</p>
                  <p className="text-xs text-[#a1a1a1] mt-0.5">{m.desc}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-4">
          <div className="bg-[#141414] border border-[#262626] border-l-2 border-l-[#00E5A0] rounded-lg p-4 flex gap-3">
            <Sparkles className="w-5 h-5 text-[#fafafa] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[#a1a1a1]">The system prompt defines your AI&apos;s personality. Write as if briefing someone to respond exactly like you. Your model goes live immediately!</p>
          </div>
          <textarea value={form.system_prompt} onChange={(e) => updateField('system_prompt', e.target.value)} rows={12} placeholder="You are [Name], a [expertise]. You speak in a [tone] way..." className="w-full bg-[#141414] border border-[#262626] rounded-lg px-4 py-3 text-[#fafafa] focus:border-[#444] focus:outline-none resize-none font-mono text-sm" />
          <p className="text-sm text-[#666]">{form.system_prompt.length} characters</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-[#a1a1a1] mb-2">Price per message: {priceDisplay(form.price_per_query)}</label>
            <input type="range" min={10000} max={1000000} step={10000} value={form.price_per_query} onChange={(e) => updateField('price_per_query', parseInt(e.target.value))} className="w-full accent-[#00E5A0]" />
            <div className="flex justify-between text-sm text-[#666] mt-1"><span>$0.01</span><span>$1.00</span></div>
          </div>
          <div className="bg-[#141414] border border-[#262626] rounded-lg p-4 space-y-2 text-sm">
            <div className="flex justify-between text-[#a1a1a1]"><span>You earn per message</span><span className="text-[#00E5A0]">{priceDisplay(Math.floor(form.price_per_query * 0.85))}</span></div>
            <div className="flex justify-between text-[#a1a1a1]"><span>Platform fee (15%)</span><span>{priceDisplay(Math.floor(form.price_per_query * 0.15))}</span></div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="bg-[#141414] border border-[#262626] rounded-lg p-6 space-y-4">
          <div><span className="text-sm text-[#666]">Name</span><p className="text-[#fafafa] font-medium">{form.name}</p></div>
          <div><span className="text-sm text-[#666]">URL</span><p className="text-[#a1a1a1]">kinakuta.xyz/models/{form.slug}</p></div>
          <div><span className="text-sm text-[#666]">Base Model</span><p className="text-[#fafafa]">{selectedBaseModel?.name}</p></div>
          <div><span className="text-sm text-[#666]">Price</span><p className="text-[#fafafa]">{priceDisplay(form.price_per_query)} per message</p></div>
          <div><span className="text-sm text-[#666]">System Prompt</span><p className="text-[#a1a1a1] text-sm whitespace-pre-wrap line-clamp-4">{form.system_prompt}</p></div>
          <div className="bg-[#00E5A0]/10 border border-[#00E5A0]/20 rounded-lg p-3 text-sm text-[#00E5A0]">
            Your model will be live immediately after creation!
          </div>
        </div>
      )}

      <div className="flex justify-between mt-10">
        <button onClick={() => (step === 0 ? router.back() : setStep(step - 1))} className="flex items-center gap-2 px-6 py-3 text-[#a1a1a1] hover:text-[#fafafa] transition-colors active:scale-[0.98]">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => setStep(step + 1)} disabled={step === 0 && !form.name} className="flex items-center gap-2 px-6 py-3 bg-[#fafafa] hover:bg-[#e5e5e5] text-[#0a0a0a] rounded-lg font-medium disabled:opacity-50 transition-colors active:scale-[0.98]">
            Next <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={loading} className="flex items-center gap-2 px-6 py-3 bg-[#fafafa] hover:bg-[#e5e5e5] text-[#0a0a0a] rounded-lg font-medium disabled:opacity-50 transition-colors active:scale-[0.98]">
            {loading ? 'Creating...' : 'Create & Go Live'} <Sparkles className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
