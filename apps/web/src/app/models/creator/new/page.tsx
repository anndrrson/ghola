'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, ArrowRight, Sparkles, Check, Server } from 'lucide-react';
import { createModel, addContent } from "@/lib/api";

const STEPS = ['Basics', 'System Prompt', 'Content', 'Pricing', 'Hosting', 'Review'];

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
    self_hosted_endpoint: '',
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
                i === step ? 'bg-[#3da8ff] text-[#eef1f8]' : i < step ? 'bg-[#3da8ff]/20 text-[#3da8ff]' : 'bg-[#161822] text-[#4a5568]'
              }`}
            >
              {i < step ? <Check className="w-4 h-4" /> : i + 1}
            </button>
            {i < STEPS.length - 1 && <div className={`w-8 h-0.5 ${i < step ? 'bg-[#3da8ff]/50' : 'bg-[#161822]'}`} />}
          </div>
        ))}
      </div>

      {step === 0 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Model Name</label>
            <input type="text" value={form.name} onChange={(e) => updateField('name', e.target.value)} placeholder="e.g., Fitness Coach AI" className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">URL Slug</label>
            <div className="flex items-center bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3">
              <span className="text-[#4a5568]">ghola.xyz/models/</span>
              <input type="text" value={form.slug} onChange={(e) => updateField('slug', e.target.value)} className="bg-transparent text-[#eef1f8] flex-1 focus:outline-none" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Description</label>
            <textarea value={form.description} onChange={(e) => updateField('description', e.target.value)} rows={3} placeholder="What makes your AI unique?" className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Category</label>
            <select value={form.category} onChange={(e) => updateField('category', e.target.value)} className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none">
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
          <div className="bg-[#3da8ff]/10 border border-[#3da8ff]/30 rounded-xl p-4 flex gap-3">
            <Sparkles className="w-5 h-5 text-[#3da8ff] flex-shrink-0 mt-0.5" />
            <p className="text-sm text-[#3da8ff]">The system prompt defines your AI&apos;s personality. Write as if briefing someone to respond exactly like you.</p>
          </div>
          <textarea value={form.system_prompt} onChange={(e) => updateField('system_prompt', e.target.value)} rows={12} placeholder="You are [Name], a [expertise]. You speak in a [tone] way..." className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none resize-none font-mono text-sm" />
          <p className="text-sm text-[#4a5568]">{form.system_prompt.length} characters</p>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-6">
          <p className="text-[#8b95a8]">Add content so we can train the AI to sound like you.</p>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Paste Your Content</label>
            <textarea value={form.content_text} onChange={(e) => updateField('content_text', e.target.value)} rows={8} placeholder="Paste articles, blog posts, newsletters..." className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Blog URL (optional)</label>
            <input type="url" value={form.content_url} onChange={(e) => updateField('content_url', e.target.value)} placeholder="https://yourblog.com" className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none" />
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-[#8b95a8] mb-2">Price per message: {priceDisplay(form.price_per_query)}</label>
            <input type="range" min={10000} max={1000000} step={10000} value={form.price_per_query} onChange={(e) => updateField('price_per_query', parseInt(e.target.value))} className="w-full accent-[#3da8ff]" />
            <div className="flex justify-between text-sm text-[#4a5568] mt-1"><span>$0.01</span><span>$1.00</span></div>
          </div>
          <div className="bg-[#0f1117] rounded-xl p-4 space-y-2 text-sm">
            <div className="flex justify-between text-[#8b95a8]"><span>You earn per message</span><span className="text-[#eef1f8]">{priceDisplay(Math.floor(form.price_per_query * 0.85))}</span></div>
            <div className="flex justify-between text-[#8b95a8]"><span>Platform fee (15%)</span><span>{priceDisplay(Math.floor(form.price_per_query * 0.15))}</span></div>
          </div>
        </div>
      )}

      {step === 4 && (
        <div className="space-y-6">
          <p className="text-[#8b95a8]">Choose where your model runs inference.</p>
          <div className="space-y-3">
            <label
              className={`flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-colors ${
                !form.self_hosted_endpoint ? 'border-[#3da8ff] bg-[#3da8ff]/5' : 'border-[#1e2a3a] bg-[#0f1117] hover:border-[#2a3a50]'
              }`}
            >
              <input
                type="radio"
                name="hosting"
                checked={!form.self_hosted_endpoint}
                onChange={() => updateField('self_hosted_endpoint', '')}
                className="mt-1 accent-[#3da8ff]"
              />
              <div>
                <p className="text-[#eef1f8] font-medium">Together.ai (default)</p>
                <p className="text-sm text-[#8b95a8] mt-1">Use Together.ai&apos;s hosted infrastructure. No setup required.</p>
              </div>
            </label>
            <label
              className={`flex items-start gap-4 p-4 rounded-xl border cursor-pointer transition-colors ${
                form.self_hosted_endpoint ? 'border-[#3da8ff] bg-[#3da8ff]/5' : 'border-[#1e2a3a] bg-[#0f1117] hover:border-[#2a3a50]'
              }`}
            >
              <input
                type="radio"
                name="hosting"
                checked={!!form.self_hosted_endpoint}
                onChange={() => updateField('self_hosted_endpoint', 'https://')}
                className="mt-1 accent-[#3da8ff]"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <Server className="w-4 h-4 text-[#3da8ff]" />
                  <p className="text-[#eef1f8] font-medium">Self-hosted node</p>
                </div>
                <p className="text-sm text-[#8b95a8] mt-1">Use your own OpenAI-compatible inference endpoint registered in ghola.</p>
              </div>
            </label>
          </div>
          {form.self_hosted_endpoint && (
            <div>
              <label className="block text-sm font-medium text-[#8b95a8] mb-2">Endpoint URL</label>
              <input
                type="url"
                value={form.self_hosted_endpoint}
                onChange={(e) => updateField('self_hosted_endpoint', e.target.value)}
                placeholder="https://your-node.example.com/v1"
                className="w-full bg-[#0f1117] border border-[#1e2a3a] rounded-xl px-4 py-3 text-[#eef1f8] focus:border-[#3da8ff] focus:outline-none"
              />
              <p className="text-xs text-[#4a5568] mt-1">Must expose an OpenAI-compatible /v1/chat/completions endpoint</p>
            </div>
          )}
        </div>
      )}

      {step === 5 && (
        <div className="bg-[#0f1117] rounded-xl p-6 space-y-4">
          <div><span className="text-sm text-[#4a5568]">Name</span><p className="text-[#eef1f8] font-medium">{form.name}</p></div>
          <div><span className="text-sm text-[#4a5568]">URL</span><p className="text-[#3da8ff]">ghola.xyz/models/{form.slug}</p></div>
          <div><span className="text-sm text-[#4a5568]">Price</span><p className="text-[#eef1f8]">{priceDisplay(form.price_per_query)} per message</p></div>
          <div><span className="text-sm text-[#4a5568]">Hosting</span><p className="text-[#8b95a8] text-sm">{form.self_hosted_endpoint ? `Self-hosted: ${form.self_hosted_endpoint}` : 'Together.ai (default)'}</p></div>
          <div><span className="text-sm text-[#4a5568]">System Prompt</span><p className="text-[#8b95a8] text-sm whitespace-pre-wrap line-clamp-4">{form.system_prompt}</p></div>
          <div><span className="text-sm text-[#4a5568]">Content</span><p className="text-[#8b95a8] text-sm">{form.content_text ? `${form.content_text.length} chars` : 'None'}{form.content_url ? ` + ${form.content_url}` : ''}</p></div>
        </div>
      )}

      <div className="flex justify-between mt-10">
        <button onClick={() => (step === 0 ? router.back() : setStep(step - 1))} className="flex items-center gap-2 px-6 py-3 text-[#8b95a8] hover:text-[#eef1f8] transition-colors">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button onClick={() => setStep(step + 1)} disabled={step === 0 && !form.name} className="flex items-center gap-2 px-6 py-3 bg-[#3da8ff] hover:bg-[#5bb8ff] text-[#eef1f8] rounded-xl font-medium disabled:opacity-50 transition-colors">
            Next <ArrowRight className="w-4 h-4" />
          </button>
        ) : (
          <button onClick={handleSubmit} disabled={loading} className="flex items-center gap-2 px-6 py-3 bg-[#3da8ff] hover:bg-[#5bb8ff] text-[#eef1f8] rounded-xl font-medium disabled:opacity-50 transition-colors">
            {loading ? 'Creating...' : 'Create Model'} <Sparkles className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
