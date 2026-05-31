import React, { useState } from 'react';
import { Helmet } from 'react-helmet';
import { motion } from 'framer-motion';
import {
  Calendar,
  Clock,
  Users,
  TrendingUp,
  Zap,
  Shield,
  BarChart3,
  CheckCircle2,
  Workflow,
  Database,
  Bell,
  Lock,
  ArrowRight
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import BenefitCard from '@/components/BenefitCard.jsx';
import FeatureCard from '@/components/FeatureCard.jsx';
import TestimonialCard from '@/components/TestimonialCard.jsx';
import StatsMetric from '@/components/StatsMetric.jsx';

const HomePage = () => {
  const { toast } = useToast();
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    organization: '',
    message: ''
  });

  const benefits = [
    {
      icon: Calendar,
      title: 'Reduced scheduling errors and patient no-shows',
      description: 'Intelligent automation minimizes human error and sends automated reminders to patients, significantly reducing missed appointments.',
      metric: '42% reduction in no-shows'
    },
    {
      icon: Clock,
      title: 'Faster exam scheduling and turnaround times',
      description: 'Streamlined workflows and real-time availability checking enable rapid appointment booking and confirmation.',
      metric: '53% faster scheduling'
    },
    {
      icon: Users,
      title: 'Reduced staff workload and labor costs',
      description: 'Automation handles routine scheduling tasks, freeing staff to focus on patient care and complex cases.',
      metric: '38% reduction in admin time'
    },
    {
      icon: TrendingUp,
      title: 'Improved patient satisfaction and experience',
      description: 'Convenient self-service scheduling, automated reminders, and reduced wait times create a better patient journey.',
      metric: '4.7/5 patient satisfaction'
    },
    {
      icon: Zap,
      title: 'Maximized radiology department efficiency',
      description: 'Optimized resource allocation and intelligent scheduling ensure equipment and staff are utilized effectively.',
      metric: '31% efficiency gain'
    },
    {
      icon: BarChart3,
      title: 'Reduced operational bottlenecks',
      description: 'Real-time visibility into scheduling patterns helps identify and eliminate workflow constraints.',
      metric: '47% fewer delays'
    },
    {
      icon: CheckCircle2,
      title: 'Improved patient access to scheduling',
      description: '24/7 online scheduling and mobile access make it easier for patients to book appointments at their convenience.',
      metric: '68% online booking rate'
    }
  ];

  const features = [
    {
      icon: Workflow,
      title: 'Intelligent workflow automation',
      description: 'AI-powered scheduling engine automatically assigns appointments based on equipment availability, staff schedules, and patient preferences.',
      variant: 'default'
    },
    {
      icon: Database,
      title: 'Seamless EHR integration',
      description: 'Direct integration with major EHR systems ensures patient data flows smoothly without manual data entry.',
      variant: 'muted'
    },
    {
      icon: Bell,
      title: 'Automated patient reminders',
      description: 'Multi-channel reminder system via SMS, email, and phone reduces no-shows and keeps patients informed.',
      variant: 'default'
    },
    {
      icon: Lock,
      title: 'HIPAA-compliant security',
      description: 'Enterprise-grade security and compliance features protect patient data and ensure regulatory adherence.',
      variant: 'muted'
    },
    {
      icon: BarChart3,
      title: 'Real-time analytics dashboard',
      description: 'Comprehensive reporting and analytics provide insights into scheduling patterns, utilization rates, and ROI metrics.',
      variant: 'default'
    },
    {
      icon: Users,
      title: 'Patient self-service portal',
      description: 'Intuitive online portal allows patients to schedule, reschedule, and manage appointments independently.',
      variant: 'muted'
    }
  ];

  const testimonials = [
    {
      quote: 'ValueRad transformed our radiology department. We reduced no-shows by 43% in the first quarter and our staff can finally focus on patient care instead of phone scheduling.',
      author: 'Dr. Sarah Chen',
      role: 'Director of Radiology',
      organization: 'Meridian Medical Center'
    },
    {
      quote: 'The ROI was immediate. Within 60 days, we saw a 51% reduction in scheduling time and our patient satisfaction scores jumped from 3.8 to 4.6 out of 5.',
      author: 'Marcus Thompson',
      role: 'Operations Manager',
      organization: 'Coastal Healthcare Network'
    },
    {
      quote: 'Integration with our existing EHR was seamless. The automated reminders alone saved us countless hours of staff time and dramatically reduced missed appointments.',
      author: 'Dr. Priya Patel',
      role: 'Chief Medical Officer',
      organization: 'Summit Regional Hospital'
    }
  ];

  const handleSubmit = (e) => {
    e.preventDefault();

    if (!formData.name || !formData.email || !formData.organization) {
      toast({
        title: 'Please fill in all required fields',
        variant: 'destructive'
      });
      return;
    }

    toast({
      title: 'Demo request received',
      description: 'Our team will contact you within 24 hours.'
    });

    setFormData({
      name: '',
      email: '',
      organization: '',
      message: ''
    });
  };

  const handleInputChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
  };

  return (
    <>
      <Helmet>
        <title>ValueRad - Radiology scheduling automation that maximizes ROI</title>
        <meta name="description" content="Automate radiology scheduling, reduce no-shows by 42%, and improve patient satisfaction. Intelligent workflow optimization for modern healthcare." />
      </Helmet>

      <div className="min-h-screen">
        <section
          id="hero"
          className="relative min-h-[100dvh] flex items-center justify-center overflow-hidden"
        >
          <div
            className="absolute inset-0 z-0"
            style={{
              backgroundImage: 'url(https://images.unsplash.com/photo-1693264882139-6a308957c9ae)',
              backgroundSize: 'cover',
              backgroundPosition: 'center'
            }}
          >
            <div className="absolute inset-0 bg-gradient-to-br from-primary/95 via-primary/90 to-secondary/85"></div>
          </div>

          <div className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6 }}
            >
              <h1 className="text-4xl md:text-5xl lg:text-6xl font-bold text-white mb-6 leading-tight" style={{ letterSpacing: '-0.02em' }}>
                Automate radiology scheduling.<br />Maximize your ROI.
              </h1>
              <p className="text-xl md:text-2xl text-white/90 mb-8 max-w-3xl mx-auto leading-relaxed">
                Reduce no-shows by 42%, cut scheduling time in half, and improve patient satisfaction with intelligent workflow automation.
              </p>
              <Button
                size="lg"
                onClick={() => document.getElementById('contact').scrollIntoView({ behavior: 'smooth' })}
                className="bg-white text-primary hover:bg-white/90 text-lg px-8 py-6 transition-all duration-200 active:scale-[0.98]"
              >
                Request demo
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </motion.div>

            <motion.div
              initial={{ opacity: 0, y: 30 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, delay: 0.3 }}
              className="mt-16 grid grid-cols-2 md:grid-cols-4 gap-8"
            >
              <StatsMetric number="42" suffix="%" label="Fewer no-shows" />
              <StatsMetric number="53" suffix="%" label="Faster scheduling" />
              <StatsMetric number="4.7" suffix="/5" label="Patient satisfaction" />
              <StatsMetric number="31" suffix="%" label="Efficiency gain" />
            </motion.div>
          </div>
        </section>

        <section className="py-20 bg-background">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-16"
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ letterSpacing: '-0.02em' }}>
                Measurable impact on your bottom line
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                ValueRad delivers quantifiable ROI through automation, optimization, and improved patient experience.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {benefits.map((benefit, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                >
                  <BenefitCard {...benefit} index={index} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section id="how-it-works" className="py-20 bg-muted">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-16"
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ letterSpacing: '-0.02em' }}>
                How ValueRad works
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Four simple steps to transform your radiology scheduling workflow.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
              {[
                {
                  number: '01',
                  title: 'Connect your systems',
                  description: 'Integrate ValueRad with your existing EHR and scheduling systems in minutes.'
                },
                {
                  number: '02',
                  title: 'Configure workflows',
                  description: 'Set up automated rules based on your department protocols and preferences.'
                },
                {
                  number: '03',
                  title: 'Launch automation',
                  description: 'Activate intelligent scheduling and let ValueRad optimize your workflow.'
                },
                {
                  number: '04',
                  title: 'Track ROI metrics',
                  description: 'Monitor real-time analytics and measure your return on investment.'
                }
              ].map((step, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="relative"
                >
                  <div className="text-6xl font-bold text-primary/20 mb-4" style={{ letterSpacing: '-0.02em' }}>
                    {step.number}
                  </div>
                  <h3 className="text-xl font-semibold mb-3">{step.title}</h3>
                  <p className="text-muted-foreground leading-relaxed">
                    {step.description}
                  </p>
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section id="features" className="py-20 bg-background">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-16"
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ letterSpacing: '-0.02em' }}>
                Features that drive results
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                Comprehensive automation and integration capabilities designed for modern radiology departments.
              </p>
            </motion.div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {features.map((feature, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                >
                  <FeatureCard {...feature} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section className="py-20 bg-muted">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-16"
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ letterSpacing: '-0.02em' }}>
                Trusted by healthcare leaders
              </h2>
              <p className="text-lg text-muted-foreground max-w-2xl mx-auto">
                See how radiology departments are achieving measurable ROI with ValueRad.
              </p>
            </motion.div>

            <div className="columns-1 md:columns-2 lg:columns-3 gap-6 space-y-6">
              {testimonials.map((testimonial, index) => (
                <motion.div
                  key={index}
                  initial={{ opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.5, delay: index * 0.1 }}
                  className="break-inside-avoid"
                >
                  <TestimonialCard {...testimonial} />
                </motion.div>
              ))}
            </div>
          </div>
        </section>

        <section id="contact" className="py-20 bg-background">
          <div className="max-w-3xl mx-auto px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="text-center mb-12"
            >
              <h2 className="text-3xl md:text-4xl font-bold mb-4" style={{ letterSpacing: '-0.02em' }}>
                See ValueRad in action
              </h2>
              <p className="text-lg text-muted-foreground">
                Request a personalized demo and discover how ValueRad can transform your radiology department.
              </p>
            </motion.div>

            <motion.form
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              onSubmit={handleSubmit}
              className="space-y-6 bg-card p-8 rounded-2xl shadow-lg"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="name" className="block text-sm font-medium mb-2">
                    Name *
                  </label>
                  <Input
                    id="name"
                    name="name"
                    type="text"
                    value={formData.name}
                    onChange={handleInputChange}
                    placeholder="Dr. Maya Chen"
                    required
                    className="text-foreground placeholder:text-muted-foreground"
                  />
                </div>
                <div>
                  <label htmlFor="email" className="block text-sm font-medium mb-2">
                    Email *
                  </label>
                  <Input
                    id="email"
                    name="email"
                    type="email"
                    value={formData.email}
                    onChange={handleInputChange}
                    placeholder="maya.chen@hospital.com"
                    required
                    className="text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="organization" className="block text-sm font-medium mb-2">
                  Organization *
                </label>
                <Input
                  id="organization"
                  name="organization"
                  type="text"
                  value={formData.organization}
                  onChange={handleInputChange}
                  placeholder="Meridian Medical Center"
                  required
                  className="text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div>
                <label htmlFor="message" className="block text-sm font-medium mb-2">
                  Message
                </label>
                <Textarea
                  id="message"
                  name="message"
                  value={formData.message}
                  onChange={handleInputChange}
                  placeholder="Tell us about your radiology department and scheduling challenges..."
                  rows={4}
                  className="text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <Button
                type="submit"
                size="lg"
                className="w-full transition-all duration-200 active:scale-[0.98]"
              >
                Request demo
                <ArrowRight className="ml-2 w-5 h-5" />
              </Button>
            </motion.form>
          </div>
        </section>
      </div>
    </>
  );
};

export default HomePage;
