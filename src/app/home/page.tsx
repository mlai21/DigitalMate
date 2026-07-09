import type { Metadata } from "next";
import Link from "next/link";
import { DraggableMascot } from "./draggable-mascot";
import styles from "./home.module.css";
import { Reveal } from "./reveal";

export const metadata: Metadata = {
  title: "DigitalMate — 一个有性格、有记忆的私人数字伙伴",
  description:
    "平时像朋友一样陪你聊天、答疑，记得你说过的每件事；逐步成长为能替你完成实际任务的数字员工。",
};

const GITHUB_URL = "https://github.com/mlai21/DigitalMate";

const FEATURES = [
  {
    img: "/home/features/persona.webp",
    title: "稳定人设",
    text: "有名字、有性格、有语气习惯。在所有渠道里，它都是同一个「人」。",
  },
  {
    img: "/home/features/memory.webp",
    title: "长期记忆",
    text: "自动记住偏好、事件与关系，越用越懂你。记忆条目可查看、可删除。",
  },
  {
    img: "/home/features/search.webp",
    title: "联网搜索",
    text: "实时信息随口一问，答案融进它自己的语气，不是甩一堆搜索结果。",
  },
  {
    img: "/home/features/channels.webp",
    title: "多渠道同一身份",
    text: "Web、飞书、钉钉、Telegram，同一份记忆、同一个它，跨端续聊。",
  },
  {
    img: "/home/features/evolve.webp",
    title: "自我进化",
    text: "每天复盘对话、整理记忆，把学到的做法沉淀成技能，经你确认后生效。",
  },
  {
    img: "/home/features/remind.webp",
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

const SCENARIOS = [
  {
    tag: "日常问答",
    messages: [
      { from: "user", text: "明天北京什么天气？要带伞吗" },
      { from: "mate", text: "明天多云转小雨，下午两点后概率大。你不是三点要出门吗，带把伞稳妥些 ☂️" },
    ],
  },
  {
    tag: "提醒跟进",
    messages: [
      { from: "user", text: "周五之前提醒我交报销" },
      { from: "mate", text: "好，周五早上我来提醒你。别又拖到最后一天哈" },
    ],
  },
  {
    tag: "群聊参与",
    messages: [{ from: "mate", text: "（群里聊到周末去哪玩）上次你说想去爬山，XX山这周末天气不错，可以安排上" }],
  },
  {
    tag: "任务执行",
    messages: [
      { from: "user", text: "把这份销售表按区域汇总，做成 5 页汇报 PPT" },
      { from: "mate", text: "收到，稍等我看看数据。大概十分钟后给你文件" },
    ],
  },
] as const;

export default function HomePage() {
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.nav}>
          <div className={styles.logo}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="DigitalMate" className={`${styles.logoImg} ${styles.logoImgLight}`} src="/home/logo-light.png" />
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img alt="DigitalMate" className={`${styles.logoImg} ${styles.logoImgDark}`} src="/home/logo-dark.png" />
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
          <div className={styles.intro} data-mascot-bounds>
            <div className={styles.introGrid}>
              <Reveal>
                <div className={styles.statusLine}>
                  <span className={styles.statusDot} />
                  在线 · 随时可聊
                </div>
                <h1 className={styles.introTitle}>
                  一个有性格、<span className={styles.gradientWord}>有记忆</span>的私人数字伙伴
                </h1>
                <p className={styles.introSub}>
                  平时像朋友一样陪你聊天、答疑，记得你说过的每件事；逐步成长为能替你完成实际任务的数字员工。
                </p>
                <Link className={styles.btnPrimary} href="/">
                  开始对话
                </Link>
              </Reveal>
              <Reveal delay={120}>
                <div className={styles.heroVisual}>
                  <div className={styles.heroRing} aria-hidden />
                  <div className={styles.heroCorner} aria-hidden />
                  <div className={styles.heroDots} aria-hidden />
                  <div className={`${styles.chatWindow} ${styles.heroFloat}`}>
                    <DraggableMascot />
                    <div className={styles.chatDay}>上周三</div>
                    <div className={`${styles.msg} ${styles.msgUser}`}>
                      <div className={`${styles.bubble} ${styles.bubbleUser}`}>最近在准备一个部门演讲，有点紧张</div>
                    </div>
                    <div className={styles.msg}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.avatar} src="/mate-avatar.png" alt="" aria-hidden />
                      <div className={`${styles.bubble} ${styles.bubbleMate}`}>
                        紧张说明你在意呀。要不要我帮你过一遍提纲？
                      </div>
                    </div>
                    <div className={styles.chatDay}>今天</div>
                    <div className={styles.msg}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.avatar} src="/mate-avatar.png" alt="" aria-hidden />
                      <div className={`${styles.bubble} ${styles.bubbleMate}`}>
                        对了，演讲练得怎么样了？这周就要上场了吧
                      </div>
                    </div>
                    <div className={`${styles.msg} ${styles.msgUser}`}>
                      <div className={`${styles.bubble} ${styles.bubbleUser}`}>你居然还记得！练了两遍，好多了</div>
                    </div>
                    <div className={styles.msg}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img className={styles.avatar} src="/mate-avatar.png" alt="" aria-hidden />
                      <div className={`${styles.bubble} ${styles.bubbleMate} ${styles.typing}`}>
                        <i />
                        <i />
                        <i />
                      </div>
                    </div>
                  </div>
                </div>
              </Reveal>
            </div>
          </div>
        </div>

        <section className={styles.features} id="features">
          <div className={styles.wrap}>
            <Reveal>
              <div className={`${styles.sectionHead} ${styles.featuresHead}`}>
                <div className={styles.featuresHeadText}>
                  <p className={styles.sectionLabel}>特性</p>
                  <h2 className={styles.sectionTitle}>像朋友，更像一位可靠的数字员工</h2>
                  <p className={styles.sectionSub}>不只是问答工具——它有自己的样子，也记得你的样子。</p>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.featuresGif} src="/home/typing.webp" alt="" aria-hidden loading="lazy" />
              </div>
            </Reveal>
            <div className={styles.grid}>
              {FEATURES.map((feature, index) => (
                <Reveal className={styles.card} delay={60 * index} key={feature.title}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.cardImg} src={feature.img} alt="" aria-hidden loading="lazy" />
                  <h3 className={styles.cardTitle}>{feature.title}</h3>
                  <p className={styles.cardText}>{feature.text}</p>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.scenarios} id="scenarios">
          <div className={styles.wrap}>
            <Reveal>
              <div className={`${styles.sectionHead} ${styles.scenariosHead}`}>
                <div className={styles.scenariosHeadText}>
                  <p className={styles.sectionLabel}>场景</p>
                  <h2 className={styles.sectionTitle}>它出现在生活里的样子</h2>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.scenariosImg} src="/home/mascot-lying.webp" alt="" aria-hidden loading="lazy" />
              </div>
            </Reveal>
            <div className={styles.scenarioGrid}>
              {SCENARIOS.map((scenario, index) => (
                <Reveal className={styles.scenario} delay={80 * index} key={scenario.tag}>
                  <span className={styles.scenarioTag}>{scenario.tag}</span>
                  {scenario.messages.map((message) => (
                    <div
                      className={`${styles.miniBubble} ${message.from === "user" ? styles.fromUser : styles.fromMate}`}
                      key={message.text}
                    >
                      {message.text}
                    </div>
                  ))}
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.tech} id="tech">
          <div className={styles.wrap}>
            <Reveal>
              <div className={`${styles.sectionHead} ${styles.techHead}`}>
                <div className={styles.techHeadText}>
                  <p className={styles.sectionLabel}>技术</p>
                  <h2 className={styles.sectionTitle}>为「长期陪伴」设计的底层</h2>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className={styles.techImg} src="/home/mascot-phone.webp" alt="" aria-hidden loading="lazy" />
              </div>
            </Reveal>
            <div className={styles.techGrid}>
              {TECH_ITEMS.map((item, index) => (
                <Reveal className={styles.techItem} delay={60 * index} key={item.num}>
                  <span className={styles.techNum}>{item.num}</span>
                  <div>
                    <h3 className={styles.techTitle}>{item.title}</h3>
                    <p className={styles.techText}>{item.text}</p>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        <div className={styles.wrap}>
          <Reveal>
            <div className={styles.cta}>
              <h2 className={styles.ctaTitle}>今天想聊点什么？</h2>
              <p className={styles.ctaSub}>它已经在这里等你了。</p>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className={styles.ctaGif} src="/home/join.webp" alt="" aria-hidden loading="lazy" />
              <Link className={styles.btnPrimary} href="/">
                开始对话
              </Link>
            </div>
          </Reveal>
        </div>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <p className={styles.footerText}>DigitalMate · 私人数字伙伴 · 自托管部署</p>
          <div className={styles.footerLinks}>
            <a className={styles.footerLink} href={GITHUB_URL} target="_blank" rel="noopener noreferrer">
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
