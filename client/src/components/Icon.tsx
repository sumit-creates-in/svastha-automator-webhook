import type { ComponentType } from 'react';
import {
  AlarmClock,
  Bell,
  Braces,
  Calculator,
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  Cloud,
  Code2,
  Database,
  FileText,
  Filter,
  GitBranch,
  Globe,
  Hash,
  KeyRound,
  Link2,
  ListFilter,
  Lock,
  Mail,
  MessageSquare,
  MousePointerClick,
  Play,
  Repeat,
  Reply,
  Send,
  Server,
  Shuffle,
  Slack,
  Split,
  Table2,
  Timer,
  Upload,
  User,
  Wand2,
  Webhook,
  Workflow,
  Zap,
  type LucideProps,
} from 'lucide-react';

/**
 * Icons available to node and connection definitions.
 *
 * When you add a node with a new icon, import it above and add it to this map.
 * Anything unknown falls back to a plain circle, so a missing entry never breaks
 * the UI.
 */
const ICONS: Record<string, ComponentType<LucideProps>> = {
  AlarmClock,
  Bell,
  Braces,
  Calculator,
  Calendar,
  CheckCircle2,
  Circle,
  Clock,
  Cloud,
  Code2,
  Database,
  FileText,
  Filter,
  GitBranch,
  Globe,
  Hash,
  KeyRound,
  Link2,
  ListFilter,
  Lock,
  Mail,
  MessageSquare,
  MousePointerClick,
  Play,
  Repeat,
  Reply,
  Send,
  Server,
  Shuffle,
  Slack,
  Split,
  Table2,
  Timer,
  Upload,
  User,
  Wand2,
  Webhook,
  Workflow,
  Zap,
};

interface IconProps extends Omit<LucideProps, 'ref'> {
  name: string;
}

export function Icon({ name, ...props }: IconProps) {
  const Component = ICONS[name] ?? Circle;
  return <Component {...props} />;
}

export default Icon;
