import type { Metadata } from "next";
import Link from "next/link";
import styles from "./home.module.css";

export const metadata: Metadata = {
  title: "DigitalMate — 一个有性格、有记忆的私人数字伙伴",
  description:
    "平时像朋友一样陪你聊天、答疑，记得你说过的每件事；逐步成长为能替你完成实际任务的数字员工。自托管部署，数据完全自控。",
};

const FEATURES = [
  {
    icon: "🙂",
    title: "稳定人设",
    text: "有名字、有性格、有语气习惯。在所有渠道里，它都是同一个「人」。",
  },
  {
    icon: "📔",
    title: "长期记忆",
    text: "自动记住偏好、事件与关系，越用越懂你。记忆条目可查看、可删除。",
  },
  {
    icon: "🔍",
    title: "联网搜索",
    text: "实时信息随口一问，答案融进它自己的语气，不是甩一堆搜索结果。",
  },
  {
    icon: "💬",
    title: "多渠道同一身份",
    text: "Web、飞书、钉钉、Telegram，同一份记忆、同一个它，跨端续聊。",
  },
  {
    icon: "🌱",
    title: "自我进化",
    text: "每天复盘对话、整理记忆，把学到的做法沉淀成技能，经你确认后生效。",
  },
  {
    icon: "⏰",
    title: "提醒与主动跟进",
    text: "「周五提醒我交报销」，到点就来找你。主动消息有边界，绝不刷屏。",
  },
];

const TECH_ITEMS = [
  {
    num: "01",
    title: "自研 Agent 内核",
    text: "循环式工具调用、分层记忆、按需加载的技能库，为拟人体验量身定制。",
  },
  {
    num: "02",
    title: "分层记忆架构",
    text: "四层记忆分工——关键事实永远在场，陈年细节随叫随到。",
  },
  {
    num: "03",
    title: "模型无关",
    text: "统一适配层接入任意 LLM，按用途路由，成本与能力兼顾。",
  },
  {
    num: "04",
    title: "数据完全自控",
    text: "自托管部署，对话与记忆只存自有数据库，敏感信息不入长期记忆。",
  },
];

export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.nav}>
          <div className={styles.logo}>
            <span className={styles.logoMark}>D</span>
            DigitalMate
          </div>
          <nav className={styles.navLinks}>
            <a className={styles.navLink} href="#features">
              特性
            </a>
            <a className={styles.navLink} href="#scenarios">
              场景
            </a>
            <a className={styles.navLink} href="#tech">
              技术
            </a>
            <Link className={styles.btnPrimary} href="/">
              开始对话
            </Link>
          </nav>
        </div>
      </header>

      <main>
        <div className={styles.wrap}>
          <div className={styles.intro}>
            <div className={styles.introGrid}>
              <div>
                <div className={styles.statusLine}>
                  <span className={styles.statusDot} />
                  在线 · 随时可聊
                </div>
                <h1 className={styles.introTitle}>一个有性格、有记忆的私人数字伙伴</h1>
                <p className={styles.introSub}>
                  平时像朋友一样陪你聊天、答疑，记得你说过的每件事；逐步成长为能替你完成实际任务的数字员工。自托管部署，数据完全自控。
                </p>
                <Link className={styles.btnPrimary} href="/">
                  开始对话
                </Link>
              </div>
              <div className={styles.chatWindow}>
                <div className={styles.chatDay}>上周三</div>
                <div className={`${styles.msg} ${styles.msgUser}`}>
                  <div className={`${styles.bubble} ${styles.bubbleUser}`}>最近在准备一个部门演讲，有点紧张</div>
                </div>
                <div className={styles.msg}>
                  <div className={styles.avatar}>D</div>
                  <div className={`${styles.bubble} ${styles.bubbleMate}`}>
                    紧张说明你在意呀。要不要我帮你过一遍提纲？
                  </div>
                </div>
                <div className={styles.chatDay}>今天</div>
                <div className={styles.msg}>
                  <div className={styles.avatar}>D</div>
                  <div className={`${styles.bubble} ${styles.bubbleMate}`}>
                    对了，演讲练得怎么样了？这周就要上场了吧
                  </div>
                </div>
                <div className={`${styles.msg} ${styles.msgUser}`}>
                  <div className={`${styles.bubble} ${styles.bubbleUser}`}>你居然还记得！练了两遍，好多了</div>
                </div>
                <div className={styles.msg}>
                  <div className={styles.avatar}>D</div>
                  <div className={`${styles.bubble} ${styles.bubbleMate} ${styles.typing}`}>
                    <i />
                    <i />
                    <i />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <section className={styles.features} id="features">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <p className={styles.sectionLabel}>特性</p>
              <h2 className={styles.sectionTitle}>像朋友，更像一位可靠的数字员工</h2>
              <p className={styles.sectionSub}>不只是问答工具——它有自己的样子，也记得你的样子。</p>
            </div>
            <div className={styles.grid}>
              {FEATURES.map((feature) => (
                <div className={styles.card} key={feature.title}>
                  <div className={styles.cardIcon}>{feature.icon}</div>
                  <h3 className={styles.cardTitle}>{feature.title}</h3>
                  <p className={styles.cardText}>{feature.text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.scenarios} id="scenarios">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <p className={styles.sectionLabel}>场景</p>
              <h2 className={styles.sectionTitle}>它出现在生活里的样子</h2>
            </div>
            <div className={styles.scenarioGrid}>
              <div className={styles.scenario}>
                <span className={styles.scenarioTag}>日常问答</span>
                <div className={`${styles.miniBubble} ${styles.fromUser}`}>明天北京什么天气？要带伞吗</div>
                <div className={`${styles.miniBubble} ${styles.fromMate}`}>
                  明天多云转小雨，下午两点后概率大。你不是三点要出门吗，带把伞稳妥些 ☂️
                </div>
              </div>
              <div className={styles.scenario}>
                <span className={styles.scenarioTag}>提醒跟进</span>
                <div className={`${styles.miniBubble} ${styles.fromUser}`}>周五之前提醒我交报销</div>
                <div className={`${styles.miniBubble} ${styles.fromMate}`}>
                  好，周五早上我来提醒你。别又拖到最后一天哈
                </div>
              </div>
              <div className={styles.scenario}>
                <span className={styles.scenarioTag}>群聊参与</span>
                <div className={`${styles.miniBubble} ${styles.fromMate}`}>
                  （群里聊到周末去哪玩）上次你说想去爬山，XX山这周末天气不错，可以安排上
                </div>
              </div>
              <div className={styles.scenario}>
                <span className={styles.scenarioTag}>任务执行</span>
                <div className={`${styles.miniBubble} ${styles.fromUser}`}>
                  把这份销售表按区域汇总，做成 5 页汇报 PPT
                </div>
                <div className={`${styles.miniBubble} ${styles.fromMate}`}>
                  收到，稍等我看看数据。大概十分钟后给你文件
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.tech} id="tech">
          <div className={styles.wrap}>
            <div className={styles.sectionHead}>
              <p className={styles.sectionLabel}>技术</p>
              <h2 className={styles.sectionTitle}>为「长期陪伴」设计的底层</h2>
            </div>
            <div className={styles.techGrid}>
              {TECH_ITEMS.map((item) => (
                <div className={styles.techItem} key={item.num}>
                  <span className={styles.techNum}>{item.num}</span>
                  <div>
                    <h3 className={styles.cardTitle}>{item.title}</h3>
                    <p className={styles.cardText}>{item.text}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <div className={styles.wrap}>
          <div className={styles.cta}>
            <h2 className={styles.ctaTitle}>今天想聊点什么？</h2>
            <p className={styles.ctaSub}>它已经在这里等你了。</p>
            <Link className={styles.btnPrimary} href="/">
              开始对话
            </Link>
          </div>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p className={styles.footerText}>DigitalMate · 私人数字伙伴 · 自托管部署</p>
          <div className={styles.footerLinks}>
            <a
              className={styles.footerLink}
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
            >
              GitHub
            </a>
            <Link className={styles.footerLink} href="/admin">
              管理后台
            </Link>
            <Link className={styles.footerLink} href="/">
              开始对话
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
