import { Link } from 'wouter';

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' });
}

export default function LandingPage() {
  return (
    <div
      className="min-h-screen selection:bg-primary selection:text-primary-foreground"
      style={{ backgroundColor: '#0e0e10', color: '#f9f5f8', fontFamily: "'Inter', sans-serif" }}
    >
      {/* TopNavBar */}
      <nav className="fixed top-0 w-full z-50 bg-neutral-950/80 backdrop-blur-xl">
        <div className="flex justify-between items-center px-8 h-20 max-w-7xl mx-auto w-full">
          <div className="text-white font-black text-xl tracking-tighter">TikBase</div>
          <div className="hidden md:flex items-center gap-8 font-['Space_Grotesk'] text-sm tracking-tight">
            <button onClick={() => scrollTo('features')} className="text-primary font-bold transition-colors duration-300 bg-transparent border-none cursor-pointer">Features</button>
            <button onClick={() => scrollTo('pricing')} className="text-neutral-400 hover:text-primary transition-colors duration-300 bg-transparent border-none cursor-pointer">Pricing</button>
            <button onClick={() => scrollTo('faq')} className="text-neutral-400 hover:text-primary transition-colors duration-300 bg-transparent border-none cursor-pointer">FAQ</button>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/login" className="text-neutral-400 font-['Space_Grotesk'] text-sm hover:text-primary transition-colors duration-300 no-underline">Log in</Link>
            <Link href="/signup" className="bg-primary text-primary-foreground px-6 py-2.5 rounded-full font-['Space_Grotesk'] text-sm font-bold hover:brightness-110 active:scale-95 transition-all no-underline inline-block">Start Free</Link>
          </div>
        </div>
      </nav>

      <main className="pt-20">
        {/* Hero Section */}
        <section className="relative overflow-hidden px-8 pt-24 pb-12 md:pt-32 md:pb-24">
          <div className="max-w-7xl mx-auto flex flex-col items-center text-center">
            <h1 className="font-['Space_Grotesk'] text-5xl md:text-7xl font-bold tracking-tight mb-8 max-w-4xl" style={{ lineHeight: 1.05 }}>
              Two tools. One login. Half the price.
            </h1>
            {/* The pitch is the arithmetic. Every number here is a published
                list price, and the two supporting claims are the two things we
                can say without qualification: the pipeline runs nightly, and
                the free tier really is the top 10 with no card. */}
            <p className="text-[#adaaad] text-lg md:text-xl max-w-2xl mb-6 leading-relaxed" style={{ fontFamily: "'Inter', sans-serif" }}>
              Kalodata + The Daily Virals runs about <span className="text-white font-semibold">$101/month</span> across
              two tabs. TikBase replaces both for <span className="text-white font-semibold">$44.99</span>.
            </p>
            <p className="font-['IBM_Plex_Mono'] text-sm text-[#767577] mb-12">
              Updated daily · See today's top 10 free — no card required
            </p>
            <div className="flex flex-col items-center gap-4">
              <Link href="/signup" className="bg-primary text-primary-foreground px-10 py-5 rounded-full font-['Space_Grotesk'] text-lg font-bold hover:brightness-110 active:scale-95 transition-all no-underline inline-block" style={{ boxShadow: '0 0 40px rgba(221,255,175,0.15)' }}>
                {/* Said "Start Your 7-Day Free Trial". There is no trial: nothing in
                    api/create-checkout-session.ts sets one, so Pro is charged the day
                    it is bought. What is true is that signing up is free, with no card. */}
                Start Free
              </Link>
              <span className="font-['IBM_Plex_Mono'] text-xs text-[#767577] tracking-wider">$44.99/mo · Cancel anytime</span>
            </div>
            <div className="relative w-full max-w-6xl mx-auto mt-16" style={{ perspective: '1000px' }}>
              <div className="absolute -inset-10 bg-primary/20 blur-[120px] rounded-full -z-10" />
              {/* A real screenshot of the running app, captured from production.
                  The old hero was a rendered mock with a lime glow baked into
                  the raster — it survived the repaint and contradicted it. */}
              <div className="relative rounded-lg overflow-hidden transform shadow-2xl border border-[#48474a]/20">
                <img
                  alt="TikBase Top Products — ranked by revenue, with Opportunity badges"
                  className="w-full aspect-[16/10] object-cover object-top"
                  src="/shot-products.jpg"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0e0e10] via-transparent to-transparent opacity-40" />
              </div>
            </div>
          </div>
        </section>

        {/* The comparison, stated as arithmetic rather than as a claim.
            What replaced the old "Trusted by 2,000+ TikTok creators" bar and
            its four stock-photo faces: we do not have 2,000 creators, and the
            faces were not customers. Published list prices, checked 2026-08-15,
            are something a reader can verify without trusting us. */}
        <section className="py-16 border-y border-[#48474a]/10" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-3xl mx-auto px-8">
            <div className="rounded-xl border border-[#48474a]/20 overflow-hidden">
              <div className="grid grid-cols-3 text-sm">
                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 text-[#767577] font-['IBM_Plex_Mono'] text-xs uppercase tracking-wider">What you'd pay</div>
                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 text-[#adaaad]">Today</div>
                <div className="px-5 py-4 border-b border-[#48474a]/15 text-white font-semibold">With TikBase</div>

                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 text-[#adaaad]">Product &amp; sales data</div>
                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 font-['IBM_Plex_Mono']">Kalodata Starter $45.90</div>
                <div className="px-5 py-4 border-b border-[#48474a]/15 font-['IBM_Plex_Mono'] text-primary">included</div>

                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 text-[#adaaad]">Daily viral video picks</div>
                <div className="px-5 py-4 border-b border-r border-[#48474a]/15 font-['IBM_Plex_Mono']">The Daily Virals ~$55</div>
                <div className="px-5 py-4 border-b border-[#48474a]/15 font-['IBM_Plex_Mono'] text-primary">included</div>

                <div className="px-5 py-4 border-r border-[#48474a]/15 text-white font-semibold">Monthly</div>
                <div className="px-5 py-4 border-r border-[#48474a]/15 font-['IBM_Plex_Mono'] text-[#adaaad]">~$101 · two tabs, two logins</div>
                <div className="px-5 py-4 font-['IBM_Plex_Mono'] text-primary font-bold">$44.99 · one</div>
              </div>
            </div>
            <p className="text-center text-[#767577] text-xs mt-4 font-['IBM_Plex_Mono']">
              Competitor prices are their published list prices, checked 2026-08-15.
            </p>
          </div>
        </section>

        {/* Feature Highlights (Bento Grid) */}
        <section id="features" className="py-32 px-8">
          <div className="max-w-7xl mx-auto">
            <div className="mb-20">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold mb-6">Everything you need to find your next viral product</h2>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              <div className="md:col-span-2 bg-[#19191c] rounded-lg p-10 hover:bg-[#2c2c2f] transition-colors group">
                <span className="material-symbols-outlined text-primary text-4xl mb-8 block">trending_up</span>
                <h3 className="font-['Space_Grotesk'] text-2xl font-bold mb-4 text-white">Top Products Leaderboard</h3>
                <p className="text-[#adaaad] leading-relaxed">Instantly access the highest converting TikTok Shop items across every category.</p>
              </div>
              <div className="md:col-span-2 bg-[#19191c] rounded-lg p-10 hover:bg-[#2c2c2f] transition-colors group">
                <span className="material-symbols-outlined text-primary text-4xl mb-8 block">play_circle</span>
                <h3 className="font-['Space_Grotesk'] text-2xl font-bold mb-4 text-white">Viral Video Rankings</h3>
                <p className="text-[#adaaad] leading-relaxed">Analyze the hooks and structures of videos that are actually generating sales.</p>
              </div>
              <div className="md:col-span-1 bg-[#19191c] rounded-lg p-8 hover:bg-[#2c2c2f] transition-colors">
                <span className="material-symbols-outlined text-primary text-3xl mb-6 block">bolt</span>
                <h3 className="font-['Space_Grotesk'] text-xl font-bold mb-3 text-white">Refreshed Every Night</h3>
                <p className="text-[#adaaad] text-sm leading-relaxed">Minute-by-minute updates on sales velocity.</p>
              </div>
              <div className="md:col-span-3 bg-[#19191c] rounded-lg p-8 hover:bg-[#2c2c2f] transition-colors flex items-center gap-8">
                <div className="flex-shrink-0">
                  <span className="material-symbols-outlined text-primary text-4xl">category</span>
                </div>
                <div>
                  <h3 className="font-['Space_Grotesk'] text-xl font-bold mb-2 text-white">18 Niches Covered</h3>
                  <p className="text-[#adaaad] text-sm leading-relaxed">From beauty to tech gadgets, we track everything so you don't have to.</p>
                </div>
                <div className="hidden md:flex ml-auto font-['IBM_Plex_Mono'] text-primary text-3xl font-bold">18</div>
              </div>
            </div>
          </div>
        </section>

        {/* Dashboard Preview Side-by-Side */}
        <section className="py-32 px-8" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-7xl mx-auto">
            <div className="flex flex-col md:flex-row items-end justify-between gap-8 mb-16">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold max-w-xl">Built for creators who take TikTok Shop seriously</h2>
              <span className="font-['IBM_Plex_Mono'] text-primary text-sm tracking-widest uppercase mb-2">Internal Alpha Access</span>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="rounded-lg overflow-hidden bg-[#19191c] shadow-xl">
                <img
                  alt="TikBase Videos Dashboard"
                  className="w-full h-full object-cover"
                  src="/shot-leaderboard.jpg"
                />
              </div>
              <div className="rounded-lg overflow-hidden bg-[#19191c] shadow-xl">
                <img
                  alt="TikBase Products Dashboard"
                  className="w-full h-full object-cover"
                  src="/shot-product-detail.jpg"
                />
              </div>
            </div>
          </div>
        </section>

        {/* Pricing */}
        <section id="pricing" className="py-32 px-8">
          <div className="max-w-7xl mx-auto text-center mb-20">
            <h2 className="font-['Space_Grotesk'] text-4xl md:text-5xl font-bold mb-4">Simple pricing. No hidden fees.</h2>
            <p className="text-[#adaaad]" style={{ fontFamily: "'Inter', sans-serif" }}>Choose the plan that fits your creator journey.</p>
          </div>
          <div className="max-w-4xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-8">
            {/* Free Plan */}
            <div className="bg-[#19191c] rounded-lg p-12 flex flex-col border border-[#48474a]/10">
              <span className="font-['Space_Grotesk'] text-xl font-bold mb-2">Free</span>
              <div className="flex items-baseline gap-1 mb-8">
                <span className="font-['IBM_Plex_Mono'] text-4xl font-bold">$0</span>
                <span className="text-[#adaaad] text-sm">/mo</span>
              </div>
              <ul className="space-y-4 mb-12 text-left list-none p-0">
                <li className="flex items-center gap-3 text-sm text-[#adaaad]">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Today’s top 10 products
                </li>
                <li className="flex items-center gap-3 text-sm text-[#adaaad]">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Product, creator and brand search
                </li>
                <li className="flex items-center gap-3 text-sm text-[#adaaad] opacity-50">
                  <span className="material-symbols-outlined text-lg">close</span>
                  Daily Sales Data
                </li>
              </ul>
              <Link href="/signup" className="mt-auto w-full py-4 rounded-full border border-[#48474a] text-white font-['Space_Grotesk'] font-bold hover:bg-[#262528] transition-colors text-center no-underline inline-block">
                Get Started
              </Link>
            </div>
            {/* Pro Plan */}
            <div className="bg-[#19191c] rounded-lg p-12 flex flex-col relative border-2 border-primary" style={{ boxShadow: '0 0 50px rgba(221,255,175,0.1)' }}>
              <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-primary-foreground px-4 py-1 rounded-full text-[10px] uppercase tracking-widest font-bold">
                Most Popular
              </div>
              <span className="font-['Space_Grotesk'] text-xl font-bold mb-2">Pro</span>
              <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2 mb-8">
                <div className="flex items-baseline gap-1">
                  <span className="font-['IBM_Plex_Mono'] text-4xl font-bold text-white">$44.99</span>
                  <span className="text-[#adaaad] text-sm">/mo</span>
                </div>
                <div className="bg-primary/10 border border-primary/20 px-3 py-1.5 rounded-full">
                  <span className="text-primary font-bold text-[13px] font-['Space_Grotesk'] tracking-tight whitespace-nowrap">$31.49/mo (billed yearly) — Save 30%</span>
                </div>
              </div>
              <ul className="space-y-4 mb-12 text-left list-none p-0">
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Unlimited Product Access
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Full Video Hooks Library
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Daily Sales Tracker
                </li>
                <li className="flex items-center gap-3 text-sm">
                  <span className="material-symbols-outlined text-primary text-lg">check</span>
                  Priority Niche Support
                </li>
              </ul>
              <Link href="/signup" className="mt-auto w-full py-4 rounded-full bg-primary text-primary-foreground font-['Space_Grotesk'] font-bold hover:brightness-110 active:scale-95 transition-all text-center no-underline inline-block">
                Start Free, Upgrade Anytime
              </Link>
            </div>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="py-32 px-8" style={{ backgroundColor: '#131315' }}>
          <div className="max-w-3xl mx-auto">
            <h2 className="font-['Space_Grotesk'] text-4xl font-bold mb-16 text-center">Frequently Asked Questions</h2>
            <div className="space-y-4">
              {[
                'How accurate is the sales data?',
                'Can I track specific competitors?',
                'How often is the product list updated?',
                'Is there a community for TikBase users?',
                'Can I cancel my subscription anytime?',
                'Do you provide video editing templates?',
              ].map((q, i) => (
                <div key={i} className="bg-[#19191c] rounded-lg p-6">
                  <button className="flex justify-between items-center w-full text-left font-['Space_Grotesk'] font-bold text-lg bg-transparent border-none text-[#f9f5f8] cursor-pointer">
                    <span>{q}</span>
                    <span className="material-symbols-outlined">expand_more</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Final CTA */}
        <section className="py-32 px-8">
          <div className="max-w-5xl mx-auto bg-primary rounded-lg p-16 md:p-24 text-center relative overflow-hidden">
            <div className="relative z-10">
              <h2 className="font-['Space_Grotesk'] text-4xl md:text-6xl font-bold text-primary-foreground mb-8 tracking-tight">Stop guessing. Start promoting winners.</h2>
              <Link href="/signup" className="bg-[#0e0e10] text-[#f9f5f8] px-12 py-5 rounded-full font-['Space_Grotesk'] text-xl font-bold hover:opacity-90 transition-opacity active:scale-95 no-underline inline-block">
                Get Started Now
              </Link>
            </div>
            <div className="absolute top-0 right-0 w-64 h-64 bg-primary-foreground/10 rounded-full blur-3xl -mr-32 -mt-32" />
            <div className="absolute bottom-0 left-0 w-64 h-64 bg-primary-foreground/10 rounded-full blur-3xl -ml-32 -mb-32" />
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="bg-neutral-950">
        <div className="flex flex-col md:flex-row justify-between items-center max-w-7xl mx-auto gap-6 w-full py-12 px-8">
          <div className="text-white font-black text-lg">TikBase</div>
          <div className="flex gap-8 font-['IBM_Plex_Mono'] text-xs uppercase tracking-widest">
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Terms</a>
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Privacy</a>
            <a className="text-neutral-500 hover:text-white transition-colors opacity-80 hover:opacity-100" href="#">Contact</a>
          </div>
          <div className="font-['IBM_Plex_Mono'] text-xs uppercase tracking-widest text-neutral-500">
            2026 TikBase
          </div>
        </div>
      </footer>
    </div>
  );
}
